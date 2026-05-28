/*
 * Trigger a refresh on the ESP32 over its UART REPL and dump the serial
 * output for a few seconds. TS port of capture_refresh.py.
 *
 *   npm run esp32:capture                       # 15s on the default port
 *   npm run esp32:capture -- --secs 20 --port /dev/cu.SLAB_USBtoUART
 */
import { SerialPort } from "serialport";

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) out[a.slice(2)] = argv[++i] ?? "";
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const path = args.port || "/dev/cu.SLAB_USBtoUART";
  const secs = args.secs ? parseFloat(args.secs) : 15;

  const port = new SerialPort({ path, baudRate: 115200 });
  port.on("error", e => { console.error("serial error:", e.message); process.exit(1); });
  port.on("data", (buf: Buffer) => process.stdout.write(buf.toString("utf-8")));

  await new Promise(r => port.once("open", r));
  setTimeout(() => { port.write("\r\nrefresh\r\n"); }, 400);
  setTimeout(() => { port.close(); }, secs * 1000);
}

main();
