/**
 * BLE Protocol Cracker for SLCK Light (Amaran 150c)
 * 
 * Systematically tests command patterns to find the control protocol.
 * WATCH THE LIGHT while running this!
 */

// @ts-ignore
import noble from "@abandonware/noble";

const LIGHT_ADDRESS = "b3ed1263a9304e5132b3edfbb4c71aec";

// All writable characteristics discovered
const WRITABLE_CHARS = [
  { uuid: "ff02", service: "ff01", name: "Vendor FF02" },
  { uuid: "7fcb", service: "7fd3", name: "Custom 7FCB" },
  { uuid: "2adb", service: "7fdd", name: "Custom 2ADB" },
  { uuid: "2add", service: "1828", name: "Mesh Provisioning" },
  { uuid: "000102030405060708090a0b0c0d7fdf", service: "000102030405060708090a0b0c0d7fde", name: "Long UUID 7FDF" },
  { uuid: "000102030405060708090a0b0c0d2b12", service: "000102030405060708090a0b0c0d1912", name: "Long UUID 2B12" },
];

// Command patterns to try - common across many BLE lights
const COMMAND_PATTERNS = [
  // Simple single bytes
  { name: "ON: 0x01", data: [0x01] },
  { name: "OFF: 0x00", data: [0x00] },
  { name: "ON: 0xFF", data: [0xff] },
  
  // Two-byte patterns (state + value)
  { name: "ON: 01 01", data: [0x01, 0x01] },
  { name: "OFF: 01 00", data: [0x01, 0x00] },
  { name: "ON: 00 01", data: [0x00, 0x01] },
  { name: "OFF: 00 00", data: [0x00, 0x00] },
  
  // With 0x7E header (common in many LED protocols)
  { name: "7E ON", data: [0x7e, 0x04, 0x04, 0x00, 0x00, 0x00, 0xff, 0x00, 0xef] },
  { name: "7E OFF", data: [0x7e, 0x04, 0x04, 0x00, 0x00, 0x00, 0x00, 0x00, 0xef] },
  
  // CC prefix (common in Chinese BLE lights)  
  { name: "CC ON", data: [0xcc, 0x23, 0x33] },
  { name: "CC OFF", data: [0xcc, 0x24, 0x33] },
  
  // AA prefix patterns
  { name: "AA ON", data: [0xaa, 0x01, 0x01] },
  { name: "AA OFF", data: [0xaa, 0x01, 0x00] },
  
  // 56 prefix (Zengge/Magic Home style)
  { name: "56 ON", data: [0x56, 0x00, 0x01, 0x0f, 0xaa] },
  { name: "56 OFF", data: [0x56, 0x00, 0x00, 0x0f, 0xaa] },
  
  // BLE Mesh Generic OnOff
  { name: "Mesh ON", data: [0x82, 0x02, 0x01, 0x00] },
  { name: "Mesh OFF", data: [0x82, 0x02, 0x00, 0x00] },
  
  // Possible Sidus/SLCK patterns (guessing)
  { name: "SL ON", data: [0x53, 0x4c, 0x01] },
  { name: "SL OFF", data: [0x53, 0x4c, 0x00] },
  { name: "SLCK ON", data: [0x53, 0x4c, 0x43, 0x4b, 0x01] },
  { name: "SLCK OFF", data: [0x53, 0x4c, 0x43, 0x4b, 0x00] },
  
  // Power command variations
  { name: "PWR ON", data: [0x04, 0x01] },
  { name: "PWR OFF", data: [0x04, 0x00] },
  { name: "CMD ON", data: [0x00, 0x04, 0x01] },
  { name: "CMD OFF", data: [0x00, 0x04, 0x00] },
  
  // Full brightness
  { name: "Full bright", data: [0xff, 0xff] },
  { name: "Zero bright", data: [0x00, 0x00] },
  
  // Variations with length prefix
  { name: "Len+ON", data: [0x01, 0x01] },
  { name: "Len+OFF", data: [0x01, 0x00] },
  { name: "Len2+ON", data: [0x02, 0x01, 0x01] },
  { name: "Len2+OFF", data: [0x02, 0x01, 0x00] },
];

class BLECracker {
  private peripheral: any = null;
  private characteristics: Map<string, any> = new Map();
  private notifications: string[] = [];

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
        const addr = peripheral.address || peripheral.id;

        if (addr.toLowerCase() === LIGHT_ADDRESS.toLowerCase() || name.includes("SLCK")) {
          found = true;
          await noble.stopScanningAsync();
          
          try {
            await peripheral.connectAsync();
            console.log(`✅ Connected to ${name}\n`);
            this.peripheral = peripheral;

            const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();
            
            for (const char of characteristics) {
              this.characteristics.set(char.uuid, char);
              
              // Subscribe to all notifications
              if (char.properties.includes("notify") || char.properties.includes("indicate")) {
                char.on("data", (data: Buffer) => {
                  const msg = `[${char.uuid}] ${data.toString("hex")}`;
                  this.notifications.push(msg);
                  console.log(`📥 ${msg}`);
                });
                try { await char.subscribeAsync(); } catch {}
              }
            }

            resolve(true);
          } catch (err) {
            console.error("Connection failed:", err);
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
      }, 10000);
    });
  }

  async testCharacteristic(charUuid: string, commands: typeof COMMAND_PATTERNS): Promise<void> {
    const char = this.characteristics.get(charUuid);
    if (!char) {
      console.log(`❌ Characteristic ${charUuid} not found`);
      return;
    }

    const canWrite = char.properties.includes("write") || char.properties.includes("writeWithoutResponse");
    if (!canWrite) {
      console.log(`❌ Characteristic ${charUuid} not writable`);
      return;
    }

    console.log(`\n${"=".repeat(60)}`);
    console.log(`TESTING: ${charUuid}`);
    console.log(`${"=".repeat(60)}\n`);
    console.log("👀 WATCH THE LIGHT!\n");

    for (const cmd of commands) {
      const data = Buffer.from(cmd.data);
      console.log(`📤 ${cmd.name}: ${data.toString("hex")}`);
      
      this.notifications = [];
      
      try {
        await char.writeAsync(data, true);
        await this.sleep(1500);
        
        if (this.notifications.length > 0) {
          console.log(`   Got ${this.notifications.length} notification(s)`);
        }
      } catch (err: any) {
        console.log(`   ❌ Write failed: ${err.message}`);
      }
      
      console.log("");
    }
  }

  async testAllCharacteristics(): Promise<void> {
    for (const charInfo of WRITABLE_CHARS) {
      await this.testCharacteristic(charInfo.uuid, COMMAND_PATTERNS);
      
      console.log("\n" + "─".repeat(60));
      console.log("Did the light respond? Press Ctrl+C if you found it!");
      console.log("Continuing to next characteristic in 3 seconds...");
      console.log("─".repeat(60) + "\n");
      
      await this.sleep(3000);
    }
  }

  async testSingleChar(charUuid: string): Promise<void> {
    await this.testCharacteristic(charUuid, COMMAND_PATTERNS);
  }

  async sendRaw(charUuid: string, hexData: string): Promise<void> {
    const char = this.characteristics.get(charUuid);
    if (!char) {
      console.log(`❌ Characteristic ${charUuid} not found`);
      return;
    }

    const data = Buffer.from(hexData, "hex");
    console.log(`📤 Sending ${data.toString("hex")} to ${charUuid}`);
    
    this.notifications = [];
    await char.writeAsync(data, true);
    await this.sleep(1000);
    
    if (this.notifications.length > 0) {
      console.log("📥 Received notifications:");
      this.notifications.forEach(n => console.log(`   ${n}`));
    }
  }

  async readAll(): Promise<void> {
    console.log("\n📊 Reading all characteristics:\n");
    
    for (const [uuid, char] of this.characteristics) {
      if (char.properties.includes("read")) {
        try {
          const data = await char.readAsync();
          console.log(`${uuid}: ${data.toString("hex")}`);
        } catch {
          console.log(`${uuid}: (read error)`);
        }
      }
    }
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
  const mode = process.argv[2] || "all";
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  const cracker = new BLECracker();
  
  if (!(await cracker.connect())) {
    process.exit(1);
  }

  try {
    switch (mode) {
      case "all":
        console.log("🔬 Testing ALL characteristics with ALL command patterns");
        console.log("👀 WATCH THE LIGHT CAREFULLY!\n");
        await cracker.testAllCharacteristics();
        break;
        
      case "char":
        if (!arg1) {
          console.log("Usage: npx tsx src/ble-crack.ts char <uuid>");
          break;
        }
        await cracker.testSingleChar(arg1);
        break;
        
      case "send":
        if (!arg1 || !arg2) {
          console.log("Usage: npx tsx src/ble-crack.ts send <uuid> <hex>");
          console.log("Example: npx tsx src/ble-crack.ts send ff02 0101");
          break;
        }
        await cracker.sendRaw(arg1, arg2);
        break;
        
      case "read":
        await cracker.readAll();
        break;
        
      default:
        console.log(`
BLE Protocol Cracker for SLCK Light

Usage:
  npx tsx src/ble-crack.ts all              Test all characteristics
  npx tsx src/ble-crack.ts char <uuid>      Test specific characteristic
  npx tsx src/ble-crack.ts send <uuid> <hex> Send raw hex data
  npx tsx src/ble-crack.ts read             Read all characteristics

Characteristics to test:
  ff02    - Vendor specific (most likely)
  7fcb    - Custom control
  2adb    - Custom write
  2add    - Mesh provisioning
`);
    }
  } finally {
    await cracker.disconnect();
  }
}

main().catch(console.error);
