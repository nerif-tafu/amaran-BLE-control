/**
 * Dump ALL nearby BLE devices — no filtering.
 * Use this to find what your lights are actually advertising as.
 * Run: npx tsx src/ble-dump.ts
 */

console.log("Starting BLE dump (this line is synchronous)...");

// @ts-ignore
import noble from "@abandonware/noble";

console.log("Noble loaded. Waiting for Bluetooth state...");

const seen = new Map<string, any>();

noble.on("stateChange", async (state: string) => {
  console.log(`Bluetooth state: ${state}`);
  if (state === "poweredOn") {
    console.log("Scanning for 15 seconds — ALL devices...\n");
    await noble.startScanningAsync([], true);
  } else if (state === "unauthorized") {
    console.error("Bluetooth permission denied. Grant Bluetooth access to your terminal app in System Preferences → Privacy & Security → Bluetooth.");
    process.exit(1);
  }
});

noble.on("discover", (p: any) => {
  const addr = p.address || p.id;
  if (seen.has(addr)) return; // deduplicate
  seen.set(addr, true);

  const name = p.advertisement.localName || "(no name)";
  const services = (p.advertisement.serviceUuids || []).join(", ") || "(none)";
  const rssi = p.rssi;
  const mfr = p.advertisement.manufacturerData ? p.advertisement.manufacturerData.toString("hex") : "";

  console.log(`  ${name.padEnd(24)} | ${addr.padEnd(36)} | rssi: ${String(rssi).padStart(4)} | services: [${services}]${mfr ? " | mfr: " + mfr : ""}`);
});

setTimeout(async () => {
  await noble.stopScanningAsync();
  console.log(`\nFound ${seen.size} devices total.`);
  console.log("\nLook for your lights above. They're likely named 'SLCK...' or similar.");
  process.exit(0);
}, 15000);
