/**
 * Direct BLE Control for Amaran 150c (SLCK Light)
 * 
 * Uses Bluetooth Mesh Proxy Protocol to send commands.
 * Based on reverse-engineering of the Amaran Desktop app.
 * 
 * Bluetooth Mesh Standard Opcodes:
 * - Generic OnOff Set: 0x8202 (acknowledged), 0x8203 (unacknowledged)
 * - Light Lightness Set: 0x824C (acknowledged)
 * - Light CTL Set: 0x825E (acknowledged)
 */

// @ts-ignore
import noble from "@abandonware/noble";

const LIGHT_ADDRESS = "b3ed1263a9304e5132b3edfbb4c71aec";

// Mesh Proxy Service (standard BLE Mesh)
const MESH_PROXY_SERVICE = "1828";
const MESH_PROXY_DATA_IN = "2add";  // Write to send mesh messages
const MESH_PROXY_DATA_OUT = "2ade"; // Notifications for responses

// Mesh opcodes (little-endian for 2-byte opcodes)
const OPCODES = {
  GENERIC_ONOFF_GET: 0x8201,
  GENERIC_ONOFF_SET: 0x8202,
  GENERIC_ONOFF_SET_UNACK: 0x8203,
  LIGHT_LIGHTNESS_GET: 0x824B,
  LIGHT_LIGHTNESS_SET: 0x824C,
  LIGHT_LIGHTNESS_SET_UNACK: 0x824D,
  LIGHT_CTL_GET: 0x825D,
  LIGHT_CTL_SET: 0x825E,
  LIGHT_CTL_SET_UNACK: 0x825F,
};

// Mesh Proxy PDU types
const PROXY_PDU_TYPE = {
  NETWORK_PDU: 0x00,
  MESH_BEACON: 0x01,
  PROXY_CONFIG: 0x02,
  PROVISIONING_PDU: 0x03,
};

class MeshProxyController {
  private peripheral: any = null;
  private dataInChar: any = null;
  private dataOutChar: any = null;
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
        const addr = peripheral.address || peripheral.id;

        if (addr.toLowerCase() === LIGHT_ADDRESS.toLowerCase() || name.includes("SLCK")) {
          found = true;
          await noble.stopScanningAsync();

          try {
            await peripheral.connectAsync();
            console.log(`✅ Connected to ${name}\n`);
            this.peripheral = peripheral;

            // Find mesh proxy characteristics
            const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
              [MESH_PROXY_SERVICE],
              [MESH_PROXY_DATA_IN, MESH_PROXY_DATA_OUT]
            );

            for (const char of characteristics) {
              if (char.uuid === MESH_PROXY_DATA_IN) {
                this.dataInChar = char;
                console.log("✅ Found Mesh Proxy Data In characteristic");
              }
              if (char.uuid === MESH_PROXY_DATA_OUT) {
                this.dataOutChar = char;
                console.log("✅ Found Mesh Proxy Data Out characteristic");
                
                // Subscribe to notifications
                char.on("data", (data: Buffer) => {
                  console.log(`📥 Mesh response: ${data.toString("hex")}`);
                  this.parseMeshResponse(data);
                });
                await char.subscribeAsync();
              }
            }

            if (!this.dataInChar) {
              console.error("❌ Mesh Proxy Data In characteristic not found");
              resolve(false);
              return;
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

  private parseMeshResponse(data: Buffer) {
    if (data.length < 1) return;
    
    const pduType = data[0] & 0x3F;
    const sar = (data[0] >> 6) & 0x03;
    
    console.log(`   PDU Type: ${pduType}, SAR: ${sar}`);
    
    if (pduType === PROXY_PDU_TYPE.NETWORK_PDU) {
      console.log("   Network PDU received");
    } else if (pduType === PROXY_PDU_TYPE.MESH_BEACON) {
      console.log("   Mesh Beacon received");
    }
  }

  private getNextTid(): number {
    this.tid = (this.tid + 1) % 256;
    return this.tid;
  }

  /**
   * Build a mesh access message
   * Note: This is simplified - real mesh requires encryption
   */
  private buildAccessMessage(opcode: number, params: number[]): Buffer {
    const opcodeBytes: number[] = [];
    
    if (opcode <= 0x7F) {
      // 1-byte opcode
      opcodeBytes.push(opcode);
    } else if (opcode <= 0x3FFF) {
      // 2-byte opcode (big-endian)
      opcodeBytes.push((opcode >> 8) & 0xFF);
      opcodeBytes.push(opcode & 0xFF);
    }

    return Buffer.from([...opcodeBytes, ...params]);
  }

  /**
   * Send a mesh proxy PDU
   * Note: Real mesh requires proper network/transport layer encryption
   */
  async sendProxyPdu(pduType: number, data: Buffer): Promise<void> {
    if (!this.dataInChar) {
      throw new Error("Not connected");
    }

    // Simple proxy PDU: type byte + data
    // SAR = 0 (complete message)
    const proxyPdu = Buffer.concat([
      Buffer.from([pduType]), // Type with SAR=0
      data
    ]);

    console.log(`📤 Sending: ${proxyPdu.toString("hex")}`);
    await this.dataInChar.writeAsync(proxyPdu, true);
  }

  /**
   * Attempt to send Generic OnOff command
   * Note: This won't work without proper mesh encryption keys
   */
  async setOnOff(isOn: boolean): Promise<void> {
    console.log(`\n💡 Attempting to set light ${isOn ? "ON" : "OFF"}...`);
    
    // Generic OnOff Set message:
    // - Opcode: 0x8202 (2 bytes)
    // - OnOff: 1 byte
    // - TID: 1 byte
    const message = this.buildAccessMessage(
      OPCODES.GENERIC_ONOFF_SET_UNACK,
      [isOn ? 0x01 : 0x00, this.getNextTid()]
    );

    console.log(`   Access message: ${message.toString("hex")}`);
    
    // Try sending as network PDU
    await this.sendProxyPdu(PROXY_PDU_TYPE.NETWORK_PDU, message);
    
    await this.sleep(500);
  }

  /**
   * Try various command formats
   */
  async tryAllFormats(): Promise<void> {
    console.log("\n🔬 Testing various mesh command formats...\n");
    console.log("Note: These may not work without proper mesh provisioning/keys.\n");

    const tests = [
      // Raw Generic OnOff Set Unack
      { name: "GenericOnOff ON (raw)", data: Buffer.from([0x82, 0x03, 0x01, 0x00]) },
      { name: "GenericOnOff OFF (raw)", data: Buffer.from([0x82, 0x03, 0x00, 0x00]) },
      
      // With proxy header
      { name: "Proxy+OnOff ON", data: Buffer.from([0x00, 0x82, 0x03, 0x01, 0x00]) },
      { name: "Proxy+OnOff OFF", data: Buffer.from([0x00, 0x82, 0x03, 0x00, 0x00]) },
      
      // Light Lightness
      { name: "Lightness 100%", data: Buffer.from([0x82, 0x4d, 0xff, 0xff, 0x00]) },
      { name: "Lightness 0%", data: Buffer.from([0x82, 0x4d, 0x00, 0x00, 0x00]) },
      
      // Vendor model attempts (Telink vendor ID is typically 0x0211)
      { name: "Vendor ON (0x0211)", data: Buffer.from([0xc0, 0x11, 0x02, 0x01]) },
      { name: "Vendor OFF (0x0211)", data: Buffer.from([0xc0, 0x11, 0x02, 0x00]) },
      
      // Try simple bytes
      { name: "Simple 0x01", data: Buffer.from([0x01]) },
      { name: "Simple 0x00", data: Buffer.from([0x00]) },
    ];

    for (const test of tests) {
      console.log(`📤 ${test.name}: ${test.data.toString("hex")}`);
      try {
        await this.dataInChar.writeAsync(test.data, true);
        console.log("   ✅ Write succeeded");
      } catch (err: any) {
        console.log(`   ❌ Write failed: ${err.message}`);
      }
      await this.sleep(2000);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
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

  const controller = new MeshProxyController();

  if (!(await controller.connect())) {
    process.exit(1);
  }

  try {
    switch (command) {
      case "on":
        await controller.setOnOff(true);
        break;
      case "off":
        await controller.setOnOff(false);
        break;
      case "test":
        await controller.tryAllFormats();
        break;
      default:
        console.log("Usage: npx tsx src/ble-direct.ts [on|off|test]");
    }
  } finally {
    await controller.disconnect();
  }
}

main().catch(console.error);
