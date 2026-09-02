/*
 * Read the amaran Desktop app's SQLite database and emit a C header with the
 * mesh credentials and fixture list the ESP32 firmware needs at compile time.
 *
 * TypeScript port of the former esp32-firmware/scripts/generate_config.py.
 * Reads the DB through the `sqlite3` CLI (same approach as src/setup.ts).
 *
 *   npm run gen-config                 # auto-detect DB, write esp32-firmware/main/mesh_config.h
 *   npm run gen-config -- --db <path> --out <path> --relay-hub <MAC>
 *
 * The generated header is KEY-BEARING — it is in .gitignore; do not commit it.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { fileURLToPath } from "url";
import { amaranDataDirs } from "../src/config.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");

// Roots the amaran Desktop app itself is installed under, per platform. Its
// fixture_config.json lives at a different depth in each bundle layout.
function appInstallCandidates(): { root: string; rel: string[] }[] {
  if (process.platform === "win32") {
    const roots = [
      process.env["ProgramFiles"],
      process.env["ProgramFiles(x86)"],
      process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, "Programs") : undefined,
    ].filter((r): r is string => !!r);
    return roots.map(root => ({ root, rel: ["resources", "config", "fixture_config.json"] }));
  }
  if (process.platform === "darwin") {
    return [{ root: "/Applications", rel: ["Contents", "Resources", "config", "fixture_config.json"] }];
  }
  return [{ root: "/opt", rel: ["resources", "config", "fixture_config.json"] }];
}

// Per-fixture capabilities come from the app's fixture_config.json, keyed by
// `fixture_<code>_<hwver>`. Some newer fixtures (e.g. Halo 100x / 401C5) are
// absent from older configs and fall back to these tables.
const FALLBACK_CAPS: Record<string, Caps> = {
  "401C5": { color: false, gm: false, cct_min: 2500, cct_max: 7500 },
};
const DEFAULT_CAPS: Caps = { color: false, gm: true, cct_min: 2700, cct_max: 6500 };

interface Caps { color: boolean; gm: boolean; cct_min: number; cct_max: number; src?: string }
interface Light { mac: string; address: number; name: string; code: string; color: boolean; gm: boolean; cct_min: number; cct_max: number }

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

// Recursively (one level) find the most-recently-modified amaran.db.
function findDB(explicit?: string): string {
  if (explicit) {
    if (!fs.existsSync(explicit)) die(`DB not found: ${explicit}`);
    return explicit;
  }
  const bases = amaranDataDirs();
  const candidates: string[] = [];
  for (const base of bases) {
    if (!fs.existsSync(base)) continue;
    try {
      // Each account lives in its own subdirectory, e.g. "80374038_secure_id/amaran.db"
      for (const d of fs.readdirSync(base)) candidates.push(path.join(base, d, "amaran.db"));
    } catch { /* unreadable directory */ }
    candidates.push(path.join(base, "amaran.db"));
  }
  const hits = candidates
    .filter(p => fs.existsSync(p))
    .map(p => ({ p, m: fs.statSync(p).mtimeMs }))
    .sort((a, b) => b.m - a.m);
  if (!hits.length) {
    die(`Could not locate amaran.db. Pass --db /path/to/amaran.db.\nTried under:\n  ${bases.join("\n  ")}`);
  }
  return hits[0].p;
}

function sqliteJson(db: string, sql: string): any[] {
  const out = execFileSync("sqlite3", ["-json", db, sql], { encoding: "utf-8" }).trim();
  return out ? JSON.parse(out) : [];
}

function findFixtureConfig(explicit?: string): string | null {
  const candidates: string[] = [];
  if (explicit) candidates.push(explicit);
  // The app copies its fixture table next to the per-account data.
  for (const base of amaranDataDirs()) {
    candidates.push(path.join(base, "config", "fixture_config.json"));
  }
  // Otherwise read it out of the installed app bundle.
  for (const { root, rel } of appInstallCandidates()) {
    try {
      for (const app of fs.readdirSync(root)) {
        if (!/maran/i.test(app)) continue;
        const p = path.join(root, app, ...rel);
        if (fs.existsSync(p)) candidates.push(p);
      }
    } catch { /* install root unreadable */ }
  }
  candidates.sort((a, b) => (fs.existsSync(b) ? fs.statSync(b).mtimeMs : 0) - (fs.existsSync(a) ? fs.statSync(a).mtimeMs : 0));
  return candidates.find(p => fs.existsSync(p)) ?? null;
}

function capsFromConfig(cfg: any, code: string, hwver: string): Caps | null {
  if (!cfg || !code) return null;
  let key: string | undefined;
  const exact = hwver ? `fixture_${code}_${hwver}` : undefined;
  if (exact && exact in cfg) {
    key = exact;
  } else {
    const cand = Object.keys(cfg).filter(k => k.startsWith(`fixture_${code}_`)).sort();
    if (!cand.length) return null;
    key = cand[0];
  }
  const e = cfg[key];
  const s = (k: string, d = "0") => String(e[k] ?? d);
  const color = s("hsi_support") === "1" || s("rgb_support") === "1";
  const gm = s("gm_support") === "1";
  let cct_min = Math.trunc(parseFloat(s("product_cct_min", "0"))) * 100;
  let cct_max = Math.trunc(parseFloat(s("product_cct_max", "0"))) * 100;
  if (!(cct_min > 0) || !(cct_max > 0) || cct_min >= cct_max) { cct_min = 2700; cct_max = 6500; }
  return { color, gm, cct_min, cct_max, src: key };
}

function extract(dbPath: string, fixtureConfigPath?: string) {
  const meshRows = sqliteJson(dbPath, "SELECT net_key, app_key FROM mesh LIMIT 1");
  if (!meshRows.length) die("mesh table is empty");
  const netKey = String(meshRows[0].net_key).trim().toLowerCase();
  const appKey = String(meshRows[0].app_key).trim().toLowerCase();

  // iv_index column shape varies across DB versions; default 0 and let the
  // firmware recover the real value from the Secure Network Beacon at runtime.
  let ivIndex = 0;
  try {
    const ivRows = sqliteJson(dbPath, "SELECT iv_index FROM mesh LIMIT 1");
    if (ivRows.length && ivRows[0].iv_index != null) ivIndex = parseInt(String(ivRows[0].iv_index), 10) || 0;
  } catch { /* no iv_index column */ }

  const fixtures = sqliteJson(
    dbPath,
    "SELECT mac_address, node_address, name, code, control_hw_version FROM fixtures WHERE node_address > 1 ORDER BY node_address",
  );

  const cfgPath = findFixtureConfig(fixtureConfigPath);
  const cfg = cfgPath ? JSON.parse(fs.readFileSync(cfgPath, "utf-8")) : null;
  if (cfgPath) console.log(`Capabilities from ${path.basename(cfgPath)}`);

  const lights: Light[] = [];
  for (const f of fixtures) {
    const mac = String(f.mac_address ?? "").trim().toUpperCase();
    const addr = parseInt(String(f.node_address), 10);
    const name = (String(f.name ?? "").trim()) || `Light ${addr}`;
    const code = String(f.code ?? "").trim().toUpperCase();
    const hwver = String(f.control_hw_version ?? "").trim();
    if (!mac || addr < 2) continue;

    let caps = capsFromConfig(cfg, code, hwver);
    let source: string;
    if (caps) { source = caps.src!; }
    else if (code in FALLBACK_CAPS) { caps = FALLBACK_CAPS[code]; source = "fallback table"; }
    else { caps = DEFAULT_CAPS; source = "default (code not in config)"; }
    console.log(`  ${name}: code=${code} hw=${hwver || "?"} color=${caps.color} gm=${caps.gm} cct=${caps.cct_min}-${caps.cct_max}K [${source}]`);

    lights.push({ mac, address: addr, name, code, color: caps.color, gm: caps.gm, cct_min: caps.cct_min, cct_max: caps.cct_max });
  }

  return { netKey, appKey, ivIndex, lights };
}

function parseHexKey(label: string, value: string): number[] {
  const cleaned = value.replace(/[\s:]/g, "");
  if (!/^[0-9a-fA-F]*$/.test(cleaned) || cleaned.length !== 32) {
    die(`${label}: expected 16 bytes of hex, got ${cleaned.length / 2}`);
  }
  const out: number[] = [];
  for (let i = 0; i < 32; i += 2) out.push(parseInt(cleaned.slice(i, i + 2), 16));
  return out;
}

function parseMac(mac: string): number[] {
  const parts = mac.replace(/-/g, ":").split(":");
  if (parts.length !== 6) die(`Bad MAC: ${mac}`);
  return parts.map(p => parseInt(p, 16));
}

const cByteArray = (data: number[]) => data.map(b => `0x${b.toString(16).padStart(2, "0")}`).join(", ");

function cIdentifier(name: string): string {
  const out: string[] = [];
  for (const ch of name.toLowerCase()) {
    if (/[a-z0-9]/.test(ch)) out.push(ch);
    else if (out.length && out[out.length - 1] !== "_") out.push("_");
  }
  return out.join("").replace(/^_+|_+$/g, "") || "light";
}

function emitHeader(data: ReturnType<typeof extract>, dbPath: string, relayHubMac?: string): string {
  const netKey = parseHexKey("net_key", data.netKey);
  const appKey = parseHexKey("app_key", data.appKey);
  const ivIndex = data.ivIndex >>> 0;
  const lights = data.lights;
  if (!lights.length) die("No lights found in fixtures table");

  let chosenRelay: Light;
  if (relayHubMac) {
    const want = relayHubMac.toUpperCase().replace(/-/g, ":");
    const found = lights.find(l => l.mac.toUpperCase().replace(/-/g, ":") === want);
    if (!found) die(`Relay hub MAC ${relayHubMac} not found among lights`);
    chosenRelay = found;
  } else {
    chosenRelay = lights[0];
  }

  const seen = new Set<string>();
  const keys = lights.map(l => {
    let k = cIdentifier(l.name);
    const base = k;
    let i = 2;
    while (seen.has(k)) k = `${base}_${i++}`;
    seen.add(k);
    return k;
  });

  const lightLines = lights.map((l, idx) => {
    const k = keys[idx];
    const mac = cByteArray(parseMac(l.mac));
    const name = l.name.replace(/"/g, '\\"');
    const addr = l.address.toString(16).padStart(4, "0");
    return `    { .key = "${k}", .name = "${name}", .mac = { ${mac} }, .address = 0x${addr}, ` +
      `.has_color = ${l.color ? "true" : "false"}, .has_gm = ${l.gm ? "true" : "false"}, ` +
      `.cct_min = ${l.cct_min}, .cct_max = ${l.cct_max} },`;
  });

  const relayMac = cByteArray(parseMac(chosenRelay.mac));
  const redactedDb = `<amaran Desktop DB: ${path.basename(path.dirname(dbPath))}>`;

  return `/*
 * Auto-generated by scripts/generate-config.ts — DO NOT EDIT BY HAND.
 * Source: ${redactedDb}
 *
 * This file is KEY-BEARING. Do not commit, paste, or share.
 */

#ifndef AMARAN_MESH_CONFIG_H
#define AMARAN_MESH_CONFIG_H

#include <stdint.h>
#include <stddef.h>
#include <stdbool.h>

#define AMARAN_LIGHT_COUNT ${lights.length}

typedef struct {
    const char *key;
    const char *name;
    uint8_t mac[6];        /* big-endian, as printed (XX:XX:XX:XX:XX:XX) */
    uint16_t address;      /* mesh unicast address */
    bool has_color;        /* RGB emitters — expose HS color in HA */
    bool has_gm;           /* accepts green/magenta tint */
    uint16_t cct_min;      /* CCT slider lower bound (Kelvin) */
    uint16_t cct_max;      /* CCT slider upper bound (Kelvin) */
} amaran_light_t;

static const uint8_t AMARAN_NET_KEY[16] = { ${cByteArray(netKey)} };
static const uint8_t AMARAN_APP_KEY[16] = { ${cByteArray(appKey)} };
static const uint32_t AMARAN_IV_INDEX_INITIAL = 0x${ivIndex.toString(16).padStart(8, "0")};
static const uint8_t AMARAN_RELAY_HUB_MAC[6] = { ${relayMac} };

/* Group / control addresses */
#define AMARAN_GROUP_ALL    0xC000
#define AMARAN_BROADCAST    0xFFFF
#define AMARAN_LOCAL_SRC    0x0001

static const amaran_light_t AMARAN_LIGHTS[AMARAN_LIGHT_COUNT] = {
${lightLines.join("\n")}
};

#endif /* AMARAN_MESH_CONFIG_H */
`;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dbPath = findDB(args.db);
  const data = extract(dbPath, args["fixture-config"]);

  const outPath = args.out || path.join(REPO_ROOT, "esp32-firmware", "main", "mesh_config.h");
  fs.mkdirSync(path.dirname(outPath), { recursive: true });

  const text = emitHeader(data, dbPath, args["relay-hub"]);
  fs.writeFileSync(outPath, text, { encoding: "utf-8", mode: 0o600 });
  fs.chmodSync(outPath, 0o600); // ensure 0600 even if the file pre-existed

  console.log(`Wrote ${outPath} (${data.lights.length} fixtures)`);
}

main();
