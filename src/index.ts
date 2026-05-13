#!/usr/bin/env node
/**
 * Amaran Light Controller
 *
 * Control your Amaran 150c light from the command line.
 *
 * Usage:
 *   amaran scan              - Scan for Bluetooth devices
 *   amaran discover <addr>   - Discover services on a BLE device
 *   amaran list              - List connected lights (via WebSocket)
 *   amaran on [device]       - Turn light on
 *   amaran off [device]      - Turn light off
 *   amaran toggle [device]   - Toggle light
 *   amaran status [device]   - Get light status
 */

const args = process.argv.slice(2);
const command = args[0];

function showHelp() {
  console.log(`
╔═══════════════════════════════════════════════════════════════════════╗
║                     AMARAN LIGHT CONTROLLER                           ║
╚═══════════════════════════════════════════════════════════════════════╝

Control your Amaran 150c light from the command line.

METHODS:
  This tool supports two methods of control:

  1. WebSocket (via Amaran Desktop app)
     Requires the Amaran Desktop app to be running.
     Commands: list, on, off, toggle, status, brightness, cct

  2. Direct Bluetooth (BLE)
     Bypasses the app entirely (experimental).
     First, use 'scan' and 'discover' to find UUIDs.

COMMANDS:

  Bluetooth Discovery:
    scan              Scan for nearby Bluetooth devices
    discover <addr>   Connect to a device and list its services

  WebSocket Control (requires Amaran Desktop app):
    list              List all connected lights
    on [device]       Turn light on
    off [device]      Turn light off
    toggle [device]   Toggle light on/off
    status [device]   Get light status
    brightness <n>    Set brightness (0-100)
    cct <kelvin>      Set color temperature (2000-10000K)

EXAMPLES:
  npx tsx src/index.ts scan
  npx tsx src/index.ts discover aa:bb:cc:dd:ee:ff
  npx tsx src/index.ts list
  npx tsx src/index.ts on
  npx tsx src/index.ts off "Key Light"
  npx tsx src/index.ts brightness 75
  npx tsx src/index.ts cct 5600

SETUP FOR DIRECT BLUETOOTH:
  1. Run: npx tsx src/index.ts scan
  2. Find your Amaran light in the list
  3. Run: npx tsx src/index.ts discover <address>
  4. Note the Service and Characteristic UUIDs
  5. Update ble-controller.ts with the UUIDs
  6. Run: npx tsx src/ble-controller.ts on
`);
}

async function main() {
  if (!command || command === "help" || command === "--help" || command === "-h") {
    showHelp();
    return;
  }

  // BLE commands
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

  // WebSocket commands - delegate to websocket-controller
  const wsArgs = ["tsx", "src/websocket-controller.ts", ...args];
  const { spawn } = await import("child_process");
  spawn("npx", wsArgs, {
    stdio: "inherit",
    cwd: process.cwd(),
  });
}

main().catch(console.error);
