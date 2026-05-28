/*
 * Subscribe to the amaran MQTT topics and print messages (incl. retained),
 * to confirm what the ESP32 bridge / daemon published to the broker.
 *
 * TS port of the former mqtt_watch.py (uses the `mqtt` dependency this repo
 * already has). Broker/credentials come from lights.json's `mqtt` config,
 * overridable with flags:
 *
 *   npm run mqtt:watch                       # 12s, topic <prefix>/#
 *   npm run mqtt:watch -- --secs 30 --broker mqtt://192.168.1.146:1883 \
 *       --user mqtt-user --pass secret --topic 'amaran/#'
 */
import mqtt from "mqtt";
import { loadConfig } from "../src/config.js";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

function main() {
  const args = parseArgs(process.argv.slice(2));

  let cfgMqtt: any = {};
  try { cfgMqtt = loadConfig().mqtt ?? {}; } catch { /* no lights.json — rely on flags */ }

  const broker = args.broker || cfgMqtt.broker;
  if (!broker) {
    console.error("No broker. Set mqtt.broker in lights.json or pass --broker mqtt://host:1883");
    process.exit(1);
  }
  const username = args.user || cfgMqtt.username;
  const password = args.pass || cfgMqtt.password;
  const prefix = cfgMqtt.topicPrefix || "amaran";
  const topic = args.topic || `${prefix}/#`;
  const secs = args.secs ? parseFloat(args.secs) : 12;

  const client = mqtt.connect(broker, { username, password, reconnectPeriod: 0 });

  client.on("connect", () => {
    console.error(`# connected ${broker}, subscribing ${topic} for ${secs}s`);
    client.subscribe(topic, err => { if (err) { console.error(err.message); process.exit(1); } });
    setTimeout(() => { client.end(true); }, secs * 1000);
  });
  client.on("message", (t, payload) => console.log(`${t}  ${payload.toString()}`));
  client.on("error", e => { console.error("MQTT error:", e.message); process.exit(1); });
}

main();
