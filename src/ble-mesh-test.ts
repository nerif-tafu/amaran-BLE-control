/**
 * BLE Mesh test for SLCK Light
 * Tests various characteristics to find the control channel
 */

// @ts-ignore
import noble from "@abandonware/noble";

const LIGHT_ADDRESS = "b3ed1263a9304e5132b3edfbb4c71aec";

interface TestChar {
  service: string;
  char: string;
  name: string;
}

const TEST_CHARS: TestChar[] = [
  { service: "7fd3", char: "7fcb", name: "Custom 7FD3" },
  { service: "7fdd", char: "2adb", name: "Custom 7FDD" },
  { service: "1828", char: "2add", name: "Mesh Provisioning" },
  { service: "000102030405060708090a0b0c0d7fde", char: "000102030405060708090a0b0c0d7fdf", name: "Custom Long" },
  { service: "000102030405060708090a0b0c0d1912", char: "000102030405060708090a0b0c0d2b12", name: "Custom 1912" },
];

// Generic On/Off model opcodes (Bluetooth Mesh standard)
const MESH_GENERIC_ONOFF_SET = Buffer.from([0x82, 0x02, 0x01, 0x00]); // On
const MESH_GENERIC_ONOFF_SET_OFF = Buffer.from([0x82, 0x02, 0x00, 0x00]); // Off
const MESH_GENERIC_ONOFF_GET = Buffer.from([0x82, 0x01]);

// Simple test commands
const SIMPLE_ON = Buffer.from([0x01]);
const SIMPLE_OFF = Buffer.from([0x00]);

async function main() {
  const command = process.argv[2] || "scan";

  console.log(`🔍 Looking for SLCK Light...\n`);

  let found = false;

  noble.on("stateChange", async (state: string) => {
    if (state === "poweredOn") {
      await noble.startScanningAsync([], true);
    }
  });

  noble.on("discover", async (peripheral: any) => {
    if (found) return;

    const address = peripheral.address || peripheral.id;
    const name = peripheral.advertisement.localName || "";

    if (address.toLowerCase() === LIGHT_ADDRESS.toLowerCase() || name.includes("SLCK")) {
      found = true;
      await noble.stopScanningAsync();
      console.log(`✅ Found: ${name}\n`);

      try {
        await peripheral.connectAsync();
        console.log("✅ Connected\n");

        // Discover all
        const { characteristics } = await peripheral.discoverAllServicesAndCharacteristicsAsync();

        // Set up notifications on all notify characteristics
        for (const char of characteristics) {
          if (char.properties.includes("notify") || char.properties.includes("indicate")) {
            try {
              char.on("data", (data: Buffer) => {
                console.log(`📥 [${char.uuid}]: ${data.toString("hex")}`);
              });
              await char.subscribeAsync();
            } catch (e) {}
          }
        }

        if (command === "scan") {
          // Just show all characteristics and their current values
          console.log("=".repeat(60));
          console.log("ALL WRITABLE CHARACTERISTICS:");
          console.log("=".repeat(60));

          for (const char of characteristics) {
            const canWrite = char.properties.includes("write") || char.properties.includes("writeWithoutResponse");
            const canRead = char.properties.includes("read");

            if (canWrite) {
              let value = "(not readable)";
              if (canRead) {
                try {
                  const data = await char.readAsync();
                  value = data.toString("hex");
                } catch (e) {
                  value = "(read error)";
                }
              }

              console.log(`\n📝 Service: ${char._serviceUuid}`);
              console.log(`   Char: ${char.uuid}`);
              console.log(`   Props: ${char.properties.join(", ")}`);
              console.log(`   Value: ${value}`);
            }
          }
        } else if (command === "test") {
          // Test sending commands to each writable characteristic
          console.log("=".repeat(60));
          console.log("TESTING ALL WRITABLE CHARACTERISTICS");
          console.log("=".repeat(60));
          console.log("\nWatching the light for any response...\n");

          for (const testChar of TEST_CHARS) {
            const char = characteristics.find(
              (c: any) =>
                c._serviceUuid.replace(/-/g, "").toLowerCase() === testChar.service.toLowerCase() &&
                c.uuid.replace(/-/g, "").toLowerCase() === testChar.char.toLowerCase()
            );

            if (!char) {
              console.log(`❌ ${testChar.name}: not found`);
              continue;
            }

            console.log(`\n🔧 Testing ${testChar.name} (${testChar.char})...`);

            // Read current value if possible
            if (char.properties.includes("read")) {
              try {
                const data = await char.readAsync();
                console.log(`   Current: ${data.toString("hex")}`);
              } catch (e) {}
            }

            // Try writing simple ON
            console.log("   Sending: 01 (ON)");
            try {
              await char.writeAsync(SIMPLE_ON, true);
              console.log("   ✅ Write succeeded");
            } catch (e: any) {
              console.log(`   ❌ Write failed: ${e.message}`);
            }

            await new Promise((r) => setTimeout(r, 2000));

            // Read again
            if (char.properties.includes("read")) {
              try {
                const data = await char.readAsync();
                console.log(`   After ON: ${data.toString("hex")}`);
              } catch (e) {}
            }

            // Try writing simple OFF
            console.log("   Sending: 00 (OFF)");
            try {
              await char.writeAsync(SIMPLE_OFF, true);
              console.log("   ✅ Write succeeded");
            } catch (e: any) {
              console.log(`   ❌ Write failed: ${e.message}`);
            }

            await new Promise((r) => setTimeout(r, 2000));
          }
        } else if (command === "mesh") {
          // Try mesh-style commands on the mesh provisioning characteristic
          const meshChar = characteristics.find((c: any) => c.uuid === "2add");

          if (!meshChar) {
            console.log("❌ Mesh provisioning characteristic not found");
          } else {
            console.log("🔧 Testing Mesh commands on 0x2ADD...\n");

            console.log("   Sending Generic OnOff GET...");
            await meshChar.writeAsync(MESH_GENERIC_ONOFF_GET, true);
            await new Promise((r) => setTimeout(r, 2000));

            console.log("   Sending Generic OnOff SET (ON)...");
            await meshChar.writeAsync(MESH_GENERIC_ONOFF_SET, true);
            await new Promise((r) => setTimeout(r, 2000));

            console.log("   Sending Generic OnOff SET (OFF)...");
            await meshChar.writeAsync(MESH_GENERIC_ONOFF_SET_OFF, true);
            await new Promise((r) => setTimeout(r, 2000));
          }
        } else if (command === "write") {
          // Manual write: npx tsx src/ble-mesh-test.ts write <char_uuid> <hex_data>
          const charUuid = process.argv[3];
          const hexData = process.argv[4];

          if (!charUuid || !hexData) {
            console.log("Usage: npx tsx src/ble-mesh-test.ts write <char_uuid> <hex_data>");
            console.log("Example: npx tsx src/ble-mesh-test.ts write 7fcb 01");
          } else {
            const char = characteristics.find(
              (c: any) => c.uuid.toLowerCase() === charUuid.toLowerCase()
            );

            if (!char) {
              console.log(`❌ Characteristic ${charUuid} not found`);
            } else {
              const data = Buffer.from(hexData, "hex");
              console.log(`📤 Writing ${data.toString("hex")} to ${charUuid}...`);

              await char.writeAsync(data, true);
              console.log("✅ Write complete");

              await new Promise((r) => setTimeout(r, 1000));

              if (char.properties.includes("read")) {
                const result = await char.readAsync();
                console.log(`📥 Read back: ${result.toString("hex")}`);
              }
            }
          }
        }

        await peripheral.disconnectAsync();
        console.log("\n📴 Disconnected");
        process.exit(0);
      } catch (error) {
        console.error("❌ Error:", error);
        process.exit(1);
      }
    }
  });

  setTimeout(async () => {
    if (!found) {
      await noble.stopScanningAsync();
      console.error("❌ Light not found");
      process.exit(1);
    }
  }, 15000);
}

main();
