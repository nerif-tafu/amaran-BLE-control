import * as fs from "fs";
import * as path from "path";
import * as os from "os";

export interface LightConfig {
  key: string;     // short name used as CLI target (e.g. "key", "back", "halo")
  name: string;    // display name
  mac: string;     // BLE MAC address (e.g. "A4:C1:38:13:41:38")
  address: number; // mesh unicast address
}

export interface HttpConfig {
  port: number;   // default 2708
  host: string;   // default "0.0.0.0"
  apiKey?: string; // if set, requests must include Authorization: Bearer <apiKey>
}

export interface MqttConfig {
  broker: string;          // e.g. "mqtt://localhost:1883"
  username?: string;
  password?: string;
  discoveryPrefix?: string; // default "homeassistant"
  topicPrefix?: string;     // default "amaran"
}

export interface Config {
  netKey: string;        // hex string, 32 chars
  appKey: string;        // hex string, 32 chars
  relayHub: string;      // MAC address of the light to connect through as BLE Mesh Proxy
  lights: LightConfig[];
  http?: HttpConfig;
  mqtt?: MqttConfig;
}

const CONFIG_PATH = path.join(process.cwd(), "lights.json");

export function loadConfig(): Config {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(
      "lights.json not found.\n" +
      "Run setup first:  npm run setup\n" +
      "Or copy the example: cp lights.example.json lights.json"
    );
  }
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, "utf-8")) as Config;
  } catch (e: any) {
    throw new Error(`lights.json is invalid: ${e.message}`);
  }
}

export function saveConfig(config: Config): void {
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n", "utf-8");
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_PATH);
}

/** Directories the amaran Desktop app stores its per-account data in, per platform. */
export function amaranDataDirs(): string[] {
  const home = os.homedir();
  if (process.platform === "win32") {
    const appData = process.env.APPDATA ?? path.join(home, "AppData", "Roaming");
    const localAppData = process.env.LOCALAPPDATA ?? path.join(home, "AppData", "Local");
    return [
      path.join(appData, "amaran Desktop"),
      path.join(localAppData, "amaran Desktop"),
    ];
  }
  if (process.platform === "darwin") {
    return [path.join(home, "Library", "Application Support", "amaran Desktop")];
  }
  return [
    path.join(process.env.XDG_CONFIG_HOME ?? path.join(home, ".config"), "amaran Desktop"),
  ];
}

export function findAmaranDB(): string | null {
  for (const base of amaranDataDirs()) {
    if (!fs.existsSync(base)) continue;
    try {
      // Each account lives in its own subdirectory, e.g. "80374038_secure_id/amaran.db"
      const hit = fs.readdirSync(base)
        .map(d => path.join(base, d, "amaran.db"))
        .find(p => fs.existsSync(p));
      if (hit) return hit;
      // Older installs put the DB straight in the data directory.
      const flat = path.join(base, "amaran.db");
      if (fs.existsSync(flat)) return flat;
    } catch {
      // unreadable directory — try the next candidate
    }
  }
  return null;
}
