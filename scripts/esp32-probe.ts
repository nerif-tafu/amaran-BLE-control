/*
 * Send a REPL command to the ESP32, then decode the status replies it logs,
 * using the SAME src/telink.ts decoder the firmware was ported from — a handy
 * cross-check that the TS and C decoders agree. TS port of probe_state.py.
 *
 * Requires the firmware built with CONFIG_BLE_MESH_STACK_TRACE_LEVEL=3 so the
 * net.c snoop logs the raw decrypted "AMARAN-STATUS ...: <hex>" lines.
 *
 *   npm run esp32:probe -- "cct 5600 50 key_light"
 *   npm run esp32:probe -- "hsi 0 100 80 key_light" --secs 8
 */
import { SerialPort } from "serialport";
import { decodeStatus } from "../src/telink.js";

const RX = /AMARAN-STATUS src (0x[0-9a-fA-F]+) dst (0x[0-9a-fA-F]+) len \d+: ([0-9a-fA-F]+)/;

function parseArgs(argv: string[]): { cmd: string; opts: Record<string, string> } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) opts[a.slice(2)] = argv[++i] ?? "";
    else positional.push(a);
  }
  return { cmd: positional.join(" "), opts };
}

async function main() {
  const { cmd, opts } = parseArgs(process.argv.slice(2));
  const path = opts.port || "/dev/cu.SLAB_USBtoUART";
  const secs = opts.secs ? parseFloat(opts.secs) : 6;

  const port = new SerialPort({ path, baudRate: 115200 });
  port.on("error", e => { console.error("serial error:", e.message); process.exit(1); });

  // Keep every distinct reply per src so the 0x02/0x01 state pages and the
  // 0x0a diagnostic page don't clobber each other.
  const seen = new Map<string, Set<string>>();
  let buf = "";
  port.on("data", (chunk: Buffer) => {
    buf += chunk.toString("utf-8");
    const lines = buf.split("\n");
    buf = lines.pop() ?? "";
    for (const line of lines) {
      const m = RX.exec(line);
      if (!m) continue;
      const set = seen.get(m[1]) ?? new Set<string>();
      set.add(m[3].toLowerCase());
      seen.set(m[1], set);
    }
  });

  await new Promise(r => port.once("open", r));
  if (cmd) { port.write(`\r\n${cmd}\r\n`); console.log(`# sent: ${cmd}`); }

  await new Promise(r => setTimeout(r, secs * 1000));
  port.close();

  for (const src of [...seen.keys()].sort()) {
    for (const hex of seen.get(src)!) {
      const bytes = Buffer.from(hex, "hex");
      const payload = bytes[0] === 0x26 ? bytes.subarray(1) : bytes; // strip 0x26 opcode
      const d = decodeStatus(payload);
      const desc = d
        ? `on=${d.on} ${d.isHs ? `hsi hue=${d.hue} sat=${d.sat}` : `cct ${d.cctKelvin}K gm=${d.gm}`} bri=${Math.round(d.intensity / 10)}%`
        : "(undecodable / diagnostic page)";
      console.log(`${src}: ${hex}  ->  ${desc}`);
    }
  }
}

main();
