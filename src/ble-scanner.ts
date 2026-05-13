/**
 * BLE Scanner for Amaran Lights
 *
 * This script scans for nearby Bluetooth devices and helps discover
 * the services and characteristics of your Amaran 150c light.
 *
 * Usage: npx tsx src/ble-scanner.ts [scan|connect <address>]
 */

// @ts-ignore - noble types are incomplete
import noble from "@abandonware/noble";

interface DiscoveredDevice {
  name: string;
  address: string;
  rssi: number;
  services: string[];
}

const discoveredDevices: Map<string, DiscoveredDevice> = new Map();

function formatUUID(uuid: string): string {
  // Format UUID for display
  if (uuid.length === 4) {
    return `0x${uuid.toUpperCase()}`;
  }
  return uuid;
}

async function scanForDevices(duration: number = 10000): Promise<void> {
  console.log("🔍 Scanning for Bluetooth devices...\n");
  console.log("Looking for devices with 'amaran' or 'aputure' in the name...\n");

  noble.on("stateChange", async (state: string) => {
    if (state === "poweredOn") {
      await noble.startScanningAsync([], true);
    } else {
      console.log(`Bluetooth adapter state: ${state}`);
      if (state === "poweredOff") {
        console.log("Please turn on Bluetooth and try again.");
        process.exit(1);
      }
    }
  });

  noble.on("discover", async (peripheral: any) => {
    const name = peripheral.advertisement.localName || "Unknown";
    const address = peripheral.address || peripheral.id;
    const rssi = peripheral.rssi;
    const serviceUuids = peripheral.advertisement.serviceUuids || [];

    // Store all devices
    discoveredDevices.set(address, {
      name,
      address,
      rssi,
      services: serviceUuids,
    });

    // Highlight potential Amaran devices
    const isAmaranDevice =
      name.toLowerCase().includes("amaran") ||
      name.toLowerCase().includes("aputure") ||
      name.toLowerCase().includes("150c") ||
      name.toLowerCase().includes("sidus");

    if (isAmaranDevice) {
      console.log("✨ POTENTIAL AMARAN DEVICE FOUND!");
      console.log(`   Name: ${name}`);
      console.log(`   Address: ${address}`);
      console.log(`   Signal Strength: ${rssi} dBm`);
      console.log(`   Advertised Services: ${serviceUuids.length > 0 ? serviceUuids.join(", ") : "None advertised"}`);
      console.log("");
    }
  });

  // Stop scanning after duration
  setTimeout(async () => {
    await noble.stopScanningAsync();
    console.log("\n📋 All discovered devices:\n");
    console.log("-".repeat(80));

    const devices = Array.from(discoveredDevices.values()).sort((a, b) => b.rssi - a.rssi);

    for (const device of devices) {
      const isAmaran =
        device.name.toLowerCase().includes("amaran") ||
        device.name.toLowerCase().includes("aputure") ||
        device.name.toLowerCase().includes("150c") ||
        device.name.toLowerCase().includes("sidus");

      const marker = isAmaran ? "⭐" : "  ";
      console.log(`${marker} ${device.name.padEnd(30)} | ${device.address.padEnd(20)} | ${device.rssi} dBm`);
    }

    console.log("-".repeat(80));
    console.log(`\nTotal devices found: ${discoveredDevices.size}`);
    console.log("\nTo explore a device's services, run:");
    console.log("  npx tsx src/ble-scanner.ts connect <address>\n");

    process.exit(0);
  }, duration);
}

async function connectAndExplore(address: string): Promise<void> {
  console.log(`🔗 Connecting to device: ${address}\n`);

  noble.on("stateChange", async (state: string) => {
    if (state === "poweredOn") {
      console.log("Scanning for the device...");
      await noble.startScanningAsync([], true);
    }
  });

  noble.on("discover", async (peripheral: any) => {
    const deviceAddress = peripheral.address || peripheral.id;

    if (deviceAddress.toLowerCase() === address.toLowerCase()) {
      console.log(`Found device: ${peripheral.advertisement.localName || "Unknown"}`);
      await noble.stopScanningAsync();

      try {
        console.log("Connecting...");
        await peripheral.connectAsync();
        console.log("Connected!\n");

        console.log("Discovering services and characteristics...\n");
        const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

        console.log("=".repeat(80));
        console.log("SERVICES AND CHARACTERISTICS");
        console.log("=".repeat(80));

        for (const service of services) {
          console.log(`\n📦 Service: ${formatUUID(service.uuid)}`);
          console.log("-".repeat(40));

          const serviceChars = characteristics.filter((c: any) => c._serviceUuid === service.uuid);

          for (const char of serviceChars) {
            console.log(`  📝 Characteristic: ${formatUUID(char.uuid)}`);
            console.log(`     Properties: ${char.properties.join(", ")}`);

            // Try to read if readable
            if (char.properties.includes("read")) {
              try {
                const data = await char.readAsync();
                console.log(`     Value: ${data.toString("hex")} (hex)`);
                // Try to decode as string
                const str = data.toString("utf8").replace(/[^\x20-\x7E]/g, "");
                if (str.length > 0) {
                  console.log(`     Value (string): "${str}"`);
                }
              } catch (e) {
                console.log(`     Value: (unable to read)`);
              }
            }
          }
        }

        console.log("\n" + "=".repeat(80));
        console.log("\n💡 IMPORTANT: Save the Service and Characteristic UUIDs above!");
        console.log("These are needed to control the light.\n");

        // Look for writable characteristics
        const writableChars = characteristics.filter(
          (c: any) => c.properties.includes("write") || c.properties.includes("writeWithoutResponse")
        );

        if (writableChars.length > 0) {
          console.log("📤 Writable characteristics found:");
          for (const char of writableChars) {
            console.log(`   - Service: ${formatUUID(char._serviceUuid)}, Characteristic: ${formatUUID(char.uuid)}`);
          }
          console.log("\nThese are likely candidates for control commands.\n");
        }

        await peripheral.disconnectAsync();
        console.log("Disconnected.");
        process.exit(0);
      } catch (error) {
        console.error("Error:", error);
        process.exit(1);
      }
    }
  });

  // Timeout after 30 seconds
  setTimeout(() => {
    console.log("\n❌ Device not found. Make sure:");
    console.log("   - The light is powered on");
    console.log("   - Bluetooth is enabled on your Mac");
    console.log("   - The address is correct");
    process.exit(1);
  }, 30000);
}

// Main
const args = process.argv.slice(2);
const command = args[0] || "scan";

if (command === "scan") {
  const duration = parseInt(args[1] || "10000", 10);
  scanForDevices(duration);
} else if (command === "connect") {
  const address = args[1];
  if (!address) {
    console.error("Please provide a device address.");
    console.error("Usage: npx tsx src/ble-scanner.ts connect <address>");
    process.exit(1);
  }
  connectAndExplore(address);
} else {
  console.log("Usage:");
  console.log("  npx tsx src/ble-scanner.ts scan [duration_ms]  - Scan for devices");
  console.log("  npx tsx src/ble-scanner.ts connect <address>   - Connect and explore a device");
  process.exit(1);
}
