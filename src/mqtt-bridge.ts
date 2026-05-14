#!/usr/bin/env npx tsx
/**
 * Amaran MQTT Bridge — Home Assistant integration
 *
 * Connects to an MQTT broker and publishes HA MQTT Discovery messages so
 * each light appears automatically as a native light entity in Home Assistant.
 *
 * Requires the daemon to be running (sends commands via Unix socket).
 *
 * Usage:
 *   npm run mqtt:start
 *
 * Configure in lights.json:
 *   "mqtt": {
 *     "broker": "mqtt://localhost:1883",
 *     "username": "user",
 *     "password": "pass",
 *     "discoveryPrefix": "homeassistant",
 *     "topicPrefix": "amaran"
 *   }
 */

import * as net from "net";
import { connect as mqttConnect, type MqttClient } from "mqtt";
import { loadConfig, type LightConfig, type MqttConfig } from "./config.js";
import { SOCKET_PATH } from "./daemon-paths.js";

// ── Daemon socket client ──────────────────────────────────────────────────────

function sendToDaemon(req: object): Promise<any> {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(SOCKET_PATH);
    let buf = "", settled = false;
    let timer: ReturnType<typeof setTimeout>;
    const done = (v: any) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); resolve(v); } };
    const fail = (e: Error) => { if (!settled) { settled = true; clearTimeout(timer); socket.destroy(); reject(e); } };
    socket.on("connect", () => socket.write(JSON.stringify(req) + "\n"));
    socket.on("data", chunk => {
      buf += chunk.toString();
      const lines = buf.split("\n"); buf = lines.pop() ?? "";
      for (const l of lines) if (l.trim()) try { done(JSON.parse(l)); } catch { fail(new Error("bad response")); }
    });
    socket.on("error", fail);
    socket.on("close", () => fail(new Error("daemon socket closed")));
    timer = setTimeout(() => fail(new Error("daemon timeout")), 15000);
  });
}

// ── HA MQTT helpers ───────────────────────────────────────────────────────────

// HA brightness: 0-255. Our brightness: 0-100%.
const haToPercent = (v: number) => Math.round((v / 255) * 100);
const percentToHa = (v: number) => Math.round((v / 100) * 255);

// HA color_temp: mireds (1000000/K). Our kelvin: 2500-7500.
// HA range: ~153 mireds (6500K) to ~370 mireds (2700K)
const kelvinToMireds = (k: number) => Math.round(1000000 / k);
const miredsToKelvin = (m: number) => Math.round(1000000 / m);

function makeDiscoveryPayload(light: LightConfig, topicPrefix: string) {
  const key = light.key;
  return {
    name: light.name,
    unique_id: `amaran_${key}`,
    schema: "json",
    command_topic: `${topicPrefix}/${key}/set`,
    state_topic: `${topicPrefix}/${key}/state`,
    availability_topic: `${topicPrefix}/status`,
    brightness: true,
    brightness_scale: 255,
    color_temp: true,
    min_mireds: kelvinToMireds(7500),  // ~133 mireds
    max_mireds: kelvinToMireds(2500),  // ~400 mireds
    hs: true,                           // enable HSI color picking
    device: {
      identifiers: [`amaran_${key}`],
      name: light.name,
      model: "Amaran Light",
      manufacturer: "Aputure",
    },
  };
}

// ── Light state tracking ──────────────────────────────────────────────────────

interface LightState {
  state: "ON" | "OFF";
  brightness: number;      // 0-255 (HA scale)
  color_temp?: number;     // mireds
  color_mode?: "color_temp" | "hs";
  hs_color?: [number, number]; // [hue 0-360, saturation 0-100]
}

// Default state per light
function defaultState(): LightState {
  return { state: "OFF", brightness: 255, color_temp: kelvinToMireds(5600), color_mode: "color_temp" };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const config = loadConfig();
  const mqttCfg: MqttConfig = config.mqtt ?? { broker: "mqtt://localhost:1883" };
  const discoveryPrefix = mqttCfg.discoveryPrefix ?? "homeassistant";
  const topicPrefix = mqttCfg.topicPrefix ?? "amaran";

  console.log(`MQTT bridge → ${mqttCfg.broker}`);
  console.log(`Discovery prefix: ${discoveryPrefix}  |  Topic prefix: ${topicPrefix}`);

  // Track state per light key
  const states = new Map<string, LightState>(
    config.lights.map(l => [l.key, defaultState()])
  );

  const client: MqttClient = mqttConnect(mqttCfg.broker, {
    username: mqttCfg.username,
    password: mqttCfg.password,
    will: {
      topic: `${topicPrefix}/status`,
      payload: "offline",
      retain: true,
      qos: 1,
    },
  });

  client.on("connect", () => {
    console.log("MQTT connected");

    // Mark online
    client.publish(`${topicPrefix}/status`, "online", { retain: true });

    // Publish HA discovery for each light
    for (const light of config.lights) {
      const topic = `${discoveryPrefix}/light/amaran_${light.key}/config`;
      const payload = makeDiscoveryPayload(light, topicPrefix);
      client.publish(topic, JSON.stringify(payload), { retain: true });
      console.log(`  Registered: ${light.name} (${light.key})`);

      // Publish initial state
      const state = states.get(light.key)!;
      client.publish(`${topicPrefix}/${light.key}/state`, JSON.stringify(state), { retain: true });
    }

    // Subscribe to command topics
    client.subscribe(`${topicPrefix}/+/set`);
    console.log(`Subscribed to ${topicPrefix}/+/set`);
  });

  client.on("message", async (topic, message) => {
    // Match: amaran/<key>/set
    const match = topic.match(new RegExp(`^${topicPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/set$`));
    if (!match) return;
    const lightKey = match[1];
    if (!config.lights.find(l => l.key === lightKey)) {
      console.warn(`Unknown light key in MQTT: ${lightKey}`);
      return;
    }

    let cmd: any;
    try { cmd = JSON.parse(message.toString()); } catch {
      console.error("Invalid MQTT payload:", message.toString());
      return;
    }

    const state = states.get(lightKey) ?? defaultState();
    console.log(`MQTT → ${lightKey}:`, cmd);

    try {
      // Handle state (on/off)
      if (cmd.state !== undefined) {
        const on = cmd.state === "ON";
        await sendToDaemon({ cmd: on ? "on" : "off", args: [], light: lightKey });
        state.state = on ? "ON" : "OFF";
      }

      // Handle brightness
      if (cmd.brightness !== undefined && state.state === "ON") {
        const pct = haToPercent(cmd.brightness);
        await sendToDaemon({ cmd: "brightness", args: [String(pct)], light: lightKey });
        state.brightness = cmd.brightness;
      }

      // Handle color_temp (CCT mode)
      if (cmd.color_temp !== undefined) {
        const kelvin = miredsToKelvin(cmd.color_temp);
        const pct = haToPercent(state.brightness);
        await sendToDaemon({ cmd: "cct", args: [String(pct), String(kelvin), "0"], light: lightKey });
        state.color_temp = cmd.color_temp;
        state.color_mode = "color_temp";
        delete state.hs_color;
      }

      // Handle HS color (HSI mode)
      if (cmd.hs_color !== undefined) {
        const [hue, saturation] = cmd.hs_color;
        const pct = haToPercent(state.brightness);
        await sendToDaemon({ cmd: "hsi", args: [String(pct), String(hue), String(saturation)], light: lightKey });
        state.hs_color = [hue, saturation];
        state.color_mode = "hs";
        delete state.color_temp;
      }

      // Publish updated state back
      states.set(lightKey, state);
      client.publish(`${topicPrefix}/${lightKey}/state`, JSON.stringify(state), { retain: true });
    } catch (e: any) {
      console.error(`Command failed for ${lightKey}:`, e.message);
    }
  });

  client.on("error", err => console.error("MQTT error:", err.message));
  client.on("disconnect", () => console.log("MQTT disconnected"));

  process.on("SIGINT", () => {
    client.publish(`${topicPrefix}/status`, "offline", { retain: true }, () => {
      client.end();
      process.exit(0);
    });
  });
}

run().catch(err => {
  console.error("MQTT bridge error:", err.message);
  process.exit(1);
});
