#!/usr/bin/env npx tsx
/**
 * Amaran MQTT Bridge — Home Assistant command router
 *
 * Subscribes to HA MQTT command topics and forwards them to the daemon.
 * State publishing and HA discovery are handled by the daemon itself,
 * so state stays in sync regardless of how commands arrive (CLI, HTTP, MQTT).
 *
 * Requires the daemon to be running first.
 *
 * Usage:  npm run mqtt:start
 *
 * Configure in lights.json:
 *   "mqtt": {
 *     "broker": "mqtt://localhost:1883",
 *     "username": "user",
 *     "password": "pass"
 *   }
 */

import * as net from "net";
import { connect as mqttConnect, type MqttClient } from "mqtt";
import { loadConfig } from "./config.js";
import { SOCKET_PATH } from "./daemon-paths.js";

// ── Daemon socket ─────────────────────────────────────────────────────────────

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

// ── HA format helpers ─────────────────────────────────────────────────────────

const haToPercent = (v: number) => Math.round((v / 255) * 100);
const miredsToKelvin = (m: number) => Math.round(1000000 / m);

// Translate a HA light command JSON into daemon request(s)
async function handleHACommand(lightKey: string, cmd: any) {
  if (cmd.state !== undefined) {
    const on = String(cmd.state).toUpperCase() === "ON";
    await sendToDaemon({ cmd: on ? "on" : "off", args: [], light: lightKey });
    if (!on) return; // don't apply other params when turning off
  }

  if (cmd.color_temp !== undefined) {
    const brightness = cmd.brightness !== undefined ? haToPercent(cmd.brightness) : 80;
    const kelvin = miredsToKelvin(cmd.color_temp);
    await sendToDaemon({ cmd: "cct", args: [String(brightness), String(kelvin), "0"], light: lightKey });
    return;
  }

  if (cmd.hs_color !== undefined) {
    const [hue, saturation] = cmd.hs_color;
    const brightness = cmd.brightness !== undefined ? haToPercent(cmd.brightness) : 80;
    await sendToDaemon({ cmd: "hsi", args: [String(brightness), String(hue), String(saturation)], light: lightKey });
    return;
  }

  if (cmd.brightness !== undefined) {
    await sendToDaemon({ cmd: "brightness", args: [String(haToPercent(cmd.brightness))], light: lightKey });
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function run() {
  const config = loadConfig();
  const mqttCfg = config.mqtt ?? { broker: "mqtt://localhost:1883" };
  const topicPrefix = mqttCfg.topicPrefix ?? "amaran";

  console.log(`MQTT command router → ${mqttCfg.broker}`);
  console.log(`(Discovery and state publishing are handled by the daemon)`);

  const client: MqttClient = mqttConnect(mqttCfg.broker, {
    username: mqttCfg.username,
    password: mqttCfg.password,
    reconnectPeriod: 5000,
    connectTimeout: 10000,
  });

  let connected = false;

  client.on("connect", () => {
    connected = true;
    console.log("MQTT connected");
    client.subscribe(`${topicPrefix}/+/set`);
    console.log(`Subscribed to ${topicPrefix}/+/set`);
  });

  client.on("message", async (topic, message) => {
    const match = topic.match(new RegExp(`^${topicPrefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/([^/]+)/set$`));
    if (!match) return;
    const lightKey = match[1];

    let cmd: any;
    try { cmd = JSON.parse(message.toString()); } catch {
      console.error("Invalid MQTT payload:", message.toString());
      return;
    }

    console.log(`HA → ${lightKey}:`, cmd);
    try {
      await handleHACommand(lightKey, cmd);
    } catch (e: any) {
      console.error(`Failed for ${lightKey}:`, e.message);
    }
  });

  client.on("error", (err: any) => {
    const msg = err.message || err.code || String(err);
    console.error("MQTT error:", msg);
    if (!connected && (err.code === "ECONNREFUSED" || err.code === "ENOTFOUND" || err.code === "ETIMEDOUT")) {
      console.error(`\nCould not reach MQTT broker at ${mqttCfg.broker}`);
      console.error("Is the broker running? Configure it in lights.json under \"mqtt\": { \"broker\": \"...\" }");
      client.end(true);
      process.exit(1);
    }
  });

  client.on("disconnect", () => console.log("MQTT disconnected"));

  const exit = (code = 0) => {
    try {
      client.end(true, {}, () => process.exit(code));
      setTimeout(() => process.exit(code), 2000);
    } catch { process.exit(code); }
  };

  process.on("SIGINT",  () => exit(0));
  process.on("SIGTERM", () => exit(0));
}

run().catch(err => {
  console.error("MQTT bridge error:", err.message);
  process.exit(1);
});
