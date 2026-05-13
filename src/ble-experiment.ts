/**
 * BLE Protocol Discovery for SLCK Light (Amaran 150c)
 *
 * This script experiments with different characteristics to discover
 * the control protocol.
 */

// @ts-ignore
import noble from "@abandonware/noble";

const LIGHT_ADDRESS = process.env.AMARAN_ADDRESS || "b3ed1263a9304e5132b3edfbb4c71aec";

// Discovered services and characteristics
const SERVICES = {
  VENDOR: "ff01",
  CUSTOM_7FDD: "7fdd",
  CUSTOM_7FD3: "7fd3",
  MESH_PROVISION: "1828",
  CUSTOM_LONG: "000102030405060708090a0b0c0d7fde",
  CUSTOM_1912: "000102030405060708090a0b0c0d1912",
};

const CHARACTERISTICS = {
  VENDOR_CONTROL: "ff02",
  WRITE_7FDD: "2adb",
  NOTIFY_7FDD: "2adc",
  CONTROL_7FD3: "7fcb",
  MESH_IN: "2add",
  MESH_OUT: "2ade",
  CUSTOM_7FDF: "000102030405060708090a0b0c0d7fdf",
  CUSTOM_2B12: "000102030405060708090a0b0c0d2b12",
};

// Common BLE light control patterns to try
const TEST_COMMANDS = {
  // Simple on/off patterns
  ON_SIMPLE: Buffer.from([0x01]),
  OFF_SIMPLE: Buffer.from([0x00]),

  // With command prefix patterns
  ON_PREFIX_CC: Buffer.from([0xcc, 0x23, 0x33]),  // Common LED strip pattern
  OFF_PREFIX_CC: Buffer.from([0xcc, 0x24, 0x33]),

  // Power commands with header
  ON_HEADER: Buffer.from([0x7e, 0x00, 0x04, 0x01, 0x00, 0x00, 0x00, 0x00, 0xef]),
  OFF_HEADER: Buffer.from([0x7e, 0x00, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]),

  // Status query
  STATUS_QUERY: Buffer.from([0x7e, 0x00, 0x05, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef]),

  // Possible Sidus-specific commands (guessing based on protocol patterns)
  SIDUS_ON: Buffer.from([0x53, 0x4c, 0x01, 0x01]),   // "SL" prefix + on
  SIDUS_OFF: Buffer.from([0x53, 0x4c, 0x01, 0x00]),  // "SL" prefix + off

  // Try various single bytes
  BYTE_00: Buffer.from([0x00]),
  BYTE_01: Buffer.from([0x01]),
  BYTE_FF: Buffer.from([0xff]),
};

class BLEExperiment {
  private peripheral: any = null;
  private characteristics: Map<string, any> = new Map();

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      console.log(`🔍 Looking for SLCK Light (${LIGHT_ADDRESS})...\n`);
      let found = false;

      noble.on("stateChange", async (state: string) => {
        if (state === "poweredOn") {
          await noble.startScanningAsync([], true);
        } else if (state === "poweredOff") {
          console.error("❌ Bluetooth is off");
          resolve(false);
        }
      });

      noble.on("discover", async (peripheral: any) => {
        if (found) return; // Prevent double-handling

        const address = peripheral.address || peripheral.id;
        const name = peripheral.advertisement.localName || "";

        if (
          address.toLowerCase() === LIGHT_ADDRESS.toLowerCase() ||
          name.toLowerCase().includes("slck")
        ) {
          found = true;
          await noble.stopScanningAsync();
          console.log(`✅ Found: ${name || "SLCK Light"}`);

          try {
            await peripheral.connectAsync();
            console.log("✅ Connected!\n");
            this.peripheral = peripheral;

            // Discover all services and characteristics
            const { characteristics } =
              await peripheral.discoverAllServicesAndCharacteristicsAsync();

            for (const char of characteristics) {
              const uuid = char.uuid.toLowerCase();
              this.characteristics.set(uuid, char);

              // Subscribe to notifications
              if (char.properties.includes("notify") || char.properties.includes("indicate")) {
                try {
                  await char.subscribeAsync();
                  char.on("data", (data: Buffer) => {
                    console.log(`📥 Notification from ${uuid}: ${data.toString("hex")}`);
                  });
                } catch (e) {
                  // Some characteristics don't support subscribe
                }
              }
            }

            console.log(`📋 Found ${this.characteristics.size} characteristics\n`);
            resolve(true);
          } catch (error) {
            console.error("❌ Connection error:", error);
            resolve(false);
          }
        }
      });

      setTimeout(async () => {
        if (!found) {
          await noble.stopScanningAsync();
          console.error("❌ Light not found");
          resolve(false);
        }
      }, 15000);
    });
  }

  async writeToCharacteristic(uuid: string, data: Buffer): Promise<boolean> {
    const char = this.characteristics.get(uuid.toLowerCase().replace(/-/g, ""));
    if (!char) {
      console.log(`   ❌ Characteristic ${uuid} not found`);
      return false;
    }

    const canWrite =
      char.properties.includes("write") ||
      char.properties.includes("writeWithoutResponse");

    if (!canWrite) {
      console.log(`   ❌ Characteristic ${uuid} not writable`);
      return false;
    }

    try {
      const withoutResponse = char.properties.includes("writeWithoutResponse");
      await char.writeAsync(data, withoutResponse);
      console.log(`   ✅ Wrote ${data.toString("hex")} to ${uuid}`);
      return true;
    } catch (error: any) {
      console.log(`   ❌ Write failed: ${error.message}`);
      return false;
    }
  }

  async readCharacteristic(uuid: string): Promise<Buffer | null> {
    const char = this.characteristics.get(uuid.toLowerCase().replace(/-/g, ""));
    if (!char || !char.properties.includes("read")) {
      return null;
    }

    try {
      return await char.readAsync();
    } catch (e) {
      return null;
    }
  }

  async experiment(): Promise<void> {
    console.log("=".repeat(70));
    console.log("EXPERIMENTING WITH CONTROL COMMANDS");
    console.log("=".repeat(70));
    console.log("\nWatch the light! I'll try various commands...\n");

    // Try the vendor-specific characteristic first (most likely)
    console.log("📡 Testing Service 0xFF01 / Characteristic 0xFF02 (vendor-specific):");
    console.log("-".repeat(50));

    // Read current value first
    const currentValue = await this.readCharacteristic(CHARACTERISTICS.VENDOR_CONTROL);
    if (currentValue) {
      console.log(`   Current value: ${currentValue.toString("hex")}`);
    }

    // Try simple on command
    console.log("\n   Trying ON command (0x01)...");
    await this.writeToCharacteristic(CHARACTERISTICS.VENDOR_CONTROL, TEST_COMMANDS.ON_SIMPLE);
    await this.sleep(2000);

    console.log("\n   Trying OFF command (0x00)...");
    await this.writeToCharacteristic(CHARACTERISTICS.VENDOR_CONTROL, TEST_COMMANDS.OFF_SIMPLE);
    await this.sleep(2000);

    // Try the custom 7FD3 service
    console.log("\n\n📡 Testing Service 0x7FD3 / Characteristic 0x7FCB:");
    console.log("-".repeat(50));

    console.log("\n   Trying ON command (0x01)...");
    await this.writeToCharacteristic(CHARACTERISTICS.CONTROL_7FD3, TEST_COMMANDS.ON_SIMPLE);
    await this.sleep(2000);

    console.log("\n   Trying OFF command (0x00)...");
    await this.writeToCharacteristic(CHARACTERISTICS.CONTROL_7FD3, TEST_COMMANDS.OFF_SIMPLE);
    await this.sleep(2000);

    // Try the 7FDD service
    console.log("\n\n📡 Testing Service 0x7FDD / Characteristic 0x2ADB:");
    console.log("-".repeat(50));

    console.log("\n   Trying ON command (0x01)...");
    await this.writeToCharacteristic(CHARACTERISTICS.WRITE_7FDD, TEST_COMMANDS.ON_SIMPLE);
    await this.sleep(2000);

    console.log("\n   Trying OFF command (0x00)...");
    await this.writeToCharacteristic(CHARACTERISTICS.WRITE_7FDD, TEST_COMMANDS.OFF_SIMPLE);
    await this.sleep(2000);

    // Try the long custom UUID
    console.log("\n\n📡 Testing Custom Service / Characteristic (long UUID):");
    console.log("-".repeat(50));

    console.log("\n   Trying ON command (0x01)...");
    await this.writeToCharacteristic(CHARACTERISTICS.CUSTOM_7FDF, TEST_COMMANDS.ON_SIMPLE);
    await this.sleep(2000);

    console.log("\n   Trying OFF command (0x00)...");
    await this.writeToCharacteristic(CHARACTERISTICS.CUSTOM_7FDF, TEST_COMMANDS.OFF_SIMPLE);
    await this.sleep(2000);

    console.log("\n\n" + "=".repeat(70));
    console.log("DID THE LIGHT RESPOND TO ANY COMMANDS?");
    console.log("=".repeat(70));
    console.log(`
If the light turned on/off during any of the tests above, note which
characteristic worked! We can then build the controller around that.

If nothing worked, the protocol might be more complex (encrypted or
require a specific packet format). We may need to capture Bluetooth
traffic from the Amaran app to decode it.
`);
  }

  async testSpecificCommand(charUuid: string, command: Buffer): Promise<void> {
    console.log(`\n📤 Sending ${command.toString("hex")} to ${charUuid}...`);
    await this.writeToCharacteristic(charUuid, command);
    await this.sleep(1000);
  }

  async interactiveMode(): Promise<void> {
    console.log("\n🎮 Interactive Mode");
    console.log("=".repeat(50));
    console.log("Available characteristics:");

    const writableChars: string[] = [];
    this.characteristics.forEach((char, uuid) => {
      const canWrite =
        char.properties.includes("write") ||
        char.properties.includes("writeWithoutResponse");
      if (canWrite) {
        writableChars.push(uuid);
        console.log(`  ${writableChars.length}. ${uuid} [${char.properties.join(", ")}]`);
      }
    });

    console.log("\nUse the sendCommand function to test commands.");
    console.log("Example: await sendCommand('ff02', Buffer.from([0x01]))");

    // Keep connection open for manual testing
    await this.sleep(60000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async disconnect(): Promise<void> {
    if (this.peripheral) {
      await this.peripheral.disconnectAsync();
      console.log("\n📴 Disconnected");
    }
  }
}

// Main
async function main() {
  const mode = process.argv[2] || "experiment";

  const experiment = new BLEExperiment();
  const connected = await experiment.connect();

  if (!connected) {
    process.exit(1);
  }

  try {
    if (mode === "interactive") {
      await experiment.interactiveMode();
    } else {
      await experiment.experiment();
    }
  } finally {
    await experiment.disconnect();
  }
}

main().catch(console.error);
