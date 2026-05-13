/**
 * BLE Controller for Amaran 150c Light
 *
 * This script directly controls the Amaran light via Bluetooth,
 * bypassing the Amaran Desktop app.
 *
 * NOTE: You need to first discover the service/characteristic UUIDs
 * using the ble-scanner.ts script. Update the UUIDs below once discovered.
 *
 * Usage:
 *   npx tsx src/ble-controller.ts on
 *   npx tsx src/ble-controller.ts off
 *   npx tsx src/ble-controller.ts toggle
 *   npx tsx src/ble-controller.ts status
 */

// @ts-ignore - noble types are incomplete
import noble from "@abandonware/noble";

// ============================================================================
// CONFIGURATION - Update these values after running the BLE scanner
// ============================================================================

// The Bluetooth address of your Amaran 150c light
// Find this by running: npx tsx src/ble-scanner.ts scan
const LIGHT_ADDRESS = process.env.AMARAN_ADDRESS || "";

// Service and Characteristic UUIDs - discover these with the scanner
// Run: npx tsx src/ble-scanner.ts connect <address>
const SERVICE_UUID = process.env.AMARAN_SERVICE_UUID || "";
const CONTROL_CHAR_UUID = process.env.AMARAN_CONTROL_CHAR_UUID || "";
const STATUS_CHAR_UUID = process.env.AMARAN_STATUS_CHAR_UUID || "";

// Common BLE commands for LED lights (may need adjustment for Amaran)
// These are placeholder values - you'll need to discover the actual protocol
const COMMANDS = {
  // These are example commands - the actual protocol needs to be discovered
  ON: Buffer.from([0x01]), // Placeholder
  OFF: Buffer.from([0x00]), // Placeholder
  GET_STATUS: Buffer.from([0x02]), // Placeholder
};

// ============================================================================

interface LightState {
  isOn: boolean;
  brightness?: number;
  colorTemp?: number;
}

class AmaranBLEController {
  private peripheral: any = null;
  private controlCharacteristic: any = null;
  private statusCharacteristic: any = null;
  private isConnected = false;

  async findAndConnect(): Promise<boolean> {
    if (!LIGHT_ADDRESS) {
      console.error("❌ Light address not configured!");
      console.error("");
      console.error("Please set the AMARAN_ADDRESS environment variable or update ble-controller.ts");
      console.error("");
      console.error("To find your light's address, run:");
      console.error("  npx tsx src/ble-scanner.ts scan");
      return false;
    }

    if (!SERVICE_UUID || !CONTROL_CHAR_UUID) {
      console.error("❌ Service/Characteristic UUIDs not configured!");
      console.error("");
      console.error("Please set the following environment variables:");
      console.error("  AMARAN_SERVICE_UUID");
      console.error("  AMARAN_CONTROL_CHAR_UUID");
      console.error("");
      console.error("To discover these UUIDs, run:");
      console.error("  npx tsx src/ble-scanner.ts connect " + LIGHT_ADDRESS);
      return false;
    }

    return new Promise((resolve) => {
      console.log(`🔍 Searching for Amaran light (${LIGHT_ADDRESS})...`);

      noble.on("stateChange", async (state: string) => {
        if (state === "poweredOn") {
          await noble.startScanningAsync([SERVICE_UUID], false);
        } else if (state === "poweredOff") {
          console.error("❌ Bluetooth is turned off. Please enable it.");
          resolve(false);
        }
      });

      noble.on("discover", async (peripheral: any) => {
        const address = peripheral.address || peripheral.id;

        if (address.toLowerCase() === LIGHT_ADDRESS.toLowerCase()) {
          await noble.stopScanningAsync();
          console.log(`✅ Found light: ${peripheral.advertisement.localName || "Amaran"}`);

          try {
            await peripheral.connectAsync();
            console.log("✅ Connected!");

            this.peripheral = peripheral;
            this.isConnected = true;

            // Find our control characteristic
            const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
              [SERVICE_UUID],
              [CONTROL_CHAR_UUID, STATUS_CHAR_UUID].filter(Boolean)
            );

            for (const char of characteristics) {
              if (char.uuid === CONTROL_CHAR_UUID.replace(/-/g, "").toLowerCase()) {
                this.controlCharacteristic = char;
              }
              if (STATUS_CHAR_UUID && char.uuid === STATUS_CHAR_UUID.replace(/-/g, "").toLowerCase()) {
                this.statusCharacteristic = char;
              }
            }

            if (!this.controlCharacteristic) {
              console.error("❌ Control characteristic not found!");
              resolve(false);
              return;
            }

            console.log("✅ Ready to control light\n");
            resolve(true);
          } catch (error) {
            console.error("❌ Connection error:", error);
            resolve(false);
          }
        }
      });

      // Timeout
      setTimeout(async () => {
        if (!this.isConnected) {
          await noble.stopScanningAsync();
          console.error("❌ Light not found. Make sure it's powered on and in range.");
          resolve(false);
        }
      }, 15000);
    });
  }

  async turnOn(): Promise<void> {
    if (!this.controlCharacteristic) {
      throw new Error("Not connected to light");
    }

    console.log("💡 Turning light ON...");
    await this.controlCharacteristic.writeAsync(COMMANDS.ON, false);
    console.log("✅ Light turned ON");
  }

  async turnOff(): Promise<void> {
    if (!this.controlCharacteristic) {
      throw new Error("Not connected to light");
    }

    console.log("🌙 Turning light OFF...");
    await this.controlCharacteristic.writeAsync(COMMANDS.OFF, false);
    console.log("✅ Light turned OFF");
  }

  async getStatus(): Promise<LightState | null> {
    if (!this.statusCharacteristic) {
      console.log("⚠️  Status characteristic not configured");
      return null;
    }

    try {
      const data = await this.statusCharacteristic.readAsync();
      console.log("📊 Raw status data:", data.toString("hex"));
      // Parse status based on the protocol (needs to be discovered)
      return { isOn: data[0] === 0x01 };
    } catch (error) {
      console.error("Error reading status:", error);
      return null;
    }
  }

  async toggle(): Promise<void> {
    const status = await this.getStatus();
    if (status?.isOn) {
      await this.turnOff();
    } else {
      await this.turnOn();
    }
  }

  async disconnect(): Promise<void> {
    if (this.peripheral && this.isConnected) {
      await this.peripheral.disconnectAsync();
      this.isConnected = false;
      console.log("📴 Disconnected from light");
    }
  }
}

// Main
async function main() {
  const command = process.argv[2] || "status";

  const controller = new AmaranBLEController();
  const connected = await controller.findAndConnect();

  if (!connected) {
    process.exit(1);
  }

  try {
    switch (command) {
      case "on":
        await controller.turnOn();
        break;
      case "off":
        await controller.turnOff();
        break;
      case "toggle":
        await controller.toggle();
        break;
      case "status":
        await controller.getStatus();
        break;
      default:
        console.log("Unknown command. Use: on, off, toggle, status");
    }
  } catch (error) {
    console.error("Error:", error);
  } finally {
    await controller.disconnect();
  }
}

main().catch(console.error);
