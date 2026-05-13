#!/usr/bin/env node
/**
 * Amaran Light Controller
 *
 * Control your Amaran 150c light via Direct Bluetooth (BLE).
 *
 * Usage:
 *   amaran scan              - Scan for Bluetooth devices
 *   amaran discover <addr>   - Discover services on a BLE device
 */

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                     AMARAN LIGHT CONTROLLER                           ║
╚═══════════════════════════════════════════════════════════════════════╝

Control your Amaran 150c light via Direct Bluetooth (BLE).

COMMANDS:

  Bluetooth Discovery:
    scan              Scan for nearby Bluetooth devices
    discover <addr>   Connect to a device and list its services

  Direct BLE Control:
    npm run ble:on
    npm run ble:off
    npm run mesh:on
    npm run mesh:off
    npm run mesh:brightness
    npm run mesh:cct
    npm run py:on
    npm run py:off

EXAMPLES:
  npx tsx src/index.ts scan
  npx tsx src/index.ts discover aa:bb:cc:dd:ee:ff

SETUP FOR DIRECT BLUETOOTH:
  1. Run: npx tsx src/index.ts scan
  2. Find your Amaran light in the list
  3. Run: npx tsx src/index.ts discover <address>
  4. Note the Service and Characteristic UUIDs
  5. Update ble-controller.ts with the UUIDs
  6. Run: npm run ble:on
`);
}

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    showHelp();
    return;
  }

  if (command === "scan") {
    const duration = args[1] || "10000";
    const { spawn } = await import("child_process");
    spawn("npx", ["tsx", "src/ble-scanner.ts", "scan", duration], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    return;
  }

  if (command === "discover") {
    const address = args[1];
    if (!address) {
      console.error("Please provide a device address.");
      console.error("Usage: npx tsx src/index.ts discover <address>");
      process.exit(1);
    }
    const { spawn } = await import("child_process");
    spawn("npx", ["tsx", "src/ble-scanner.ts", "connect", address], {
      stdio: "inherit",
      cwd: process.cwd(),
    });
    return;
  }

  console.error(`Unknown command: ${command}`);
  showHelp();
  process.exit(1);
}

main().catch(console.error);
