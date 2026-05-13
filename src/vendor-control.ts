/**
 * Vendor-specific control for Amaran 150c
 * 
 * Attempts to control the light using vendor commands via FF02 characteristic.
 * Based on patterns found in the Amaran Desktop app.
 */

// @ts-ignore
import noble from "@abandonware/noble";

const LIGHT_MAC = "b3ed1263a9304e5132b3edfbb4c71aec";

// Custom Sidus/Amaran characteristics
const VENDOR_SERVICE = "ff01";
const VENDOR_CHAR = "ff02";

// Additional characteristics to try
const CHAR_7FCB = "7fcb";
const SERVICE_7FD3 = "7fd3";

// Light modes from app logs
// LightModeType.CCT = 0
// LightModeCCT has: gm, cct, intensity, sleep

class VendorController {
  private peripheral: any = null;
  private vendorChar: any = null;
  private char7fcb: any = null;
  private tid = 0;

  async connect(): Promise<boolean> {
    return new Promise((resolve) => {
      console.log("🔍 Scanning for SLCK Light...\n");
      let found = false;

      noble.on("stateChange", async (state: string) => {
        if (state === "poweredOn") {
          await noble.startScanningAsync([], true);
        }
      });

      noble.on("discover", async (peripheral: any) => {
        if (found) return;
        const name = peripheral.advertisement.localName || "";
        const addr = (peripheral.address || peripheral.id || "").toLowerCase().replace(/:/g, "");

        if (addr === LIGHT_MAC.toLowerCase().replace(/-/g, "") || name.includes("SLCK")) {
          found = true;
          await noble.stopScanningAsync();

          try {
            console.log(`📡 Connecting to ${name || addr}...`);
            await peripheral.connectAsync();
            console.log("✅ Connected!\n");
            this.peripheral = peripheral;

            // Discover all services and characteristics
            const { services, characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

            console.log("📋 Found characteristics:");
            for (const char of characteristics) {
              const props = [];
              if (char.properties.includes("read")) props.push("read");
              if (char.properties.includes("write")) props.push("write");
              if (char.properties.includes("writeWithoutResponse")) props.push("writeNoResp");
              if (char.properties.includes("notify")) props.push("notify");
              
              // Find our target characteristics
              if (char.uuid === VENDOR_CHAR) {
                this.vendorChar = char;
                console.log(`   ✅ FF02 (Vendor): [${props.join(", ")}]`);
                
                // Subscribe to notifications
                if (char.properties.includes("notify")) {
                  char.on("data", (data: Buffer) => {
                    console.log(`   📥 FF02 response: ${data.toString("hex")}`);
                  });
                  await char.subscribeAsync();
                }
              } else if (char.uuid === CHAR_7FCB) {
                this.char7fcb = char;
                console.log(`   ✅ 7FCB: [${props.join(", ")}]`);
                
                if (char.properties.includes("notify")) {
                  char.on("data", (data: Buffer) => {
                    console.log(`   📥 7FCB response: ${data.toString("hex")}`);
                  });
                  await char.subscribeAsync();
                }
              }
            }

            // Read current values
            if (this.vendorChar) {
              try {
                const value = await this.vendorChar.readAsync();
                console.log(`\n📖 FF02 current value: ${value.toString("hex")}`);
              } catch (e) {}
            }
            if (this.char7fcb) {
              try {
                const value = await this.char7fcb.readAsync();
                console.log(`📖 7FCB current value: ${value.toString("hex")}`);
              } catch (e) {}
            }

            resolve(true);
          } catch (err) {
            console.error("Connection error:", err);
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

  private nextTid(): number {
    this.tid = (this.tid + 1) % 256;
    return this.tid;
  }

  async writeVendor(data: Buffer): Promise<void> {
    if (!this.vendorChar) {
      console.log("❌ FF02 characteristic not available");
      return;
    }
    console.log(`📤 Writing to FF02: ${data.toString("hex")}`);
    try {
      await this.vendorChar.writeAsync(data, true);
      console.log("   ✅ Write succeeded");
    } catch (e: any) {
      console.log(`   ❌ Write failed: ${e.message}`);
    }
  }

  async write7fcb(data: Buffer): Promise<void> {
    if (!this.char7fcb) {
      console.log("❌ 7FCB characteristic not available");
      return;
    }
    console.log(`📤 Writing to 7FCB: ${data.toString("hex")}`);
    try {
      await this.char7fcb.writeAsync(data, true);
      console.log("   ✅ Write succeeded");
    } catch (e: any) {
      console.log(`   ❌ Write failed: ${e.message}`);
    }
  }

  /**
   * Try various command formats based on the app
   */
  async tryCommands(): Promise<void> {
    console.log("\n🔬 Testing command patterns...\n");
    
    // From the app logs, we know:
    // - LightModeType.CCT = 0 
    // - intensity is 0-1000 (multiply by 10 for %)
    // - cct is in K (e.g., 3400)
    // - gm is 0-200 (green-magenta adjustment)
    // - sleep is boolean

    const commands = [
      // Simple on/off attempts
      { name: "ON byte", data: Buffer.from([0x01]) },
      { name: "OFF byte", data: Buffer.from([0x00]) },
      
      // Current value + toggle
      { name: "Toggle from 0100", data: Buffer.from([0x00, 0x00]) },
      { name: "Set to 0101", data: Buffer.from([0x01, 0x01]) },
      
      // With TID
      { name: "ON + TID", data: Buffer.from([0x01, this.nextTid()]) },
      { name: "OFF + TID", data: Buffer.from([0x00, this.nextTid()]) },
      
      // Sleep mode format (based on "set_sleep" in app)
      { name: "Sleep ON", data: Buffer.from([0x02, 0x01]) },
      { name: "Sleep OFF", data: Buffer.from([0x02, 0x00]) },
      
      // Command type + value format
      { name: "Cmd 0x10 ON", data: Buffer.from([0x10, 0x01]) },
      { name: "Cmd 0x10 OFF", data: Buffer.from([0x10, 0x00]) },
      { name: "Cmd 0x11 ON", data: Buffer.from([0x11, 0x01]) },
      { name: "Cmd 0x11 OFF", data: Buffer.from([0x11, 0x00]) },
      
      // Intensity commands (set to 100% = 0x64 or 1000 = 0x03E8)
      { name: "Intensity 100%", data: Buffer.from([0x20, 0x64]) },
      { name: "Intensity 50%", data: Buffer.from([0x20, 0x32]) },
      { name: "Intensity 0%", data: Buffer.from([0x20, 0x00]) },
      
      // Full intensity (1000 = 0x03E8)
      { name: "Intensity 1000 LE", data: Buffer.from([0x20, 0xE8, 0x03]) },
      { name: "Intensity 500 LE", data: Buffer.from([0x20, 0xF4, 0x01]) },
      
      // Telink-style vendor commands (opcode + company ID + data)
      { name: "Vendor C0 ON", data: Buffer.from([0xC0, 0x11, 0x02, 0x01]) },
      { name: "Vendor C0 OFF", data: Buffer.from([0xC0, 0x11, 0x02, 0x00]) },
      
      // Sidus specific (based on 400J5 product code)
      { name: "Sidus magic", data: Buffer.from([0x40, 0x0J, 0x01]) },
    ];

    for (const cmd of commands) {
      console.log(`\n--- Testing: ${cmd.name} ---`);
      await this.writeVendor(cmd.data);
      await this.sleep(1500);
      
      // Also try on 7FCB
      await this.write7fcb(cmd.data);
      await this.sleep(1500);
    }
  }

  /**
   * Interactive mode - send raw hex commands
   */
  async sendRaw(hexStr: string): Promise<void> {
    const data = Buffer.from(hexStr.replace(/\s/g, ""), "hex");
    console.log(`\n📤 Sending raw: ${data.toString("hex")}`);
    
    await this.writeVendor(data);
    await this.sleep(500);
    await this.write7fcb(data);
    await this.sleep(1000);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  async disconnect(): Promise<void> {
    if (this.peripheral) {
      await this.peripheral.disconnectAsync();
      console.log("\n📴 Disconnected");
    }
  }
}

async function main() {
  const command = process.argv[2] || "test";

  const controller = new VendorController();

  if (!(await controller.connect())) {
    process.exit(1);
  }

  try {
    switch (command) {
      case "test":
        await controller.tryCommands();
        break;
      case "send":
        const hex = process.argv[3];
        if (!hex) {
          console.log("Usage: send <hex>");
          break;
        }
        await controller.sendRaw(hex);
        break;
      default:
        console.log("Commands:");
        console.log("  test          - Try various command patterns");
        console.log("  send <hex>    - Send raw hex command");
    }
  } finally {
    await controller.disconnect();
  }
}

main().catch(console.error);
