/**
 * Direct BLE control test for SLCK Light
 */

// @ts-ignore
import noble from "@abandonware/noble";

const LIGHT_ADDRESS = "b3ed1263a9304e5132b3edfbb4c71aec";
const SERVICE_UUID = "ff01";
const CHAR_UUID = "ff02";

async function main() {
  const command = process.argv[2] || "status";

  console.log(`🔍 Looking for SLCK Light...`);

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
      console.log(`✅ Found: ${name}`);

      try {
        await peripheral.connectAsync();
        console.log("✅ Connected\n");

        // Discover the specific service/characteristic
        const { characteristics } = await peripheral.discoverSomeServicesAndCharacteristicsAsync(
          [SERVICE_UUID],
          [CHAR_UUID]
        );

        const char = characteristics.find((c: any) => c.uuid === CHAR_UUID);
        if (!char) {
          console.error("❌ Characteristic not found");
          await peripheral.disconnectAsync();
          process.exit(1);
        }

        // Subscribe to notifications
        char.on("data", (data: Buffer) => {
          console.log(`📥 Response: ${data.toString("hex")}`);
        });
        await char.subscribeAsync();

        // Read current value
        const currentValue = await char.readAsync();
        console.log(`📊 Current value: ${currentValue.toString("hex")}`);
        console.log(`   Byte 0: ${currentValue[0]} (possible on/off state)`);
        console.log(`   Byte 1: ${currentValue[1]} (possible brightness or other)`);

        if (command === "status") {
          console.log("\n✅ Status check complete");
        } else if (command === "on") {
          console.log("\n💡 Sending ON commands...\n");

          // Try different ON patterns
          const onCommands = [
            Buffer.from([0x01]),           // Simple on
            Buffer.from([0x01, 0x00]),     // On + 0
            Buffer.from([0x01, 0x01]),     // On + 1
            Buffer.from([0x01, 0xff]),     // On + max
            Buffer.from([0x00, 0x01]),     // Reversed
          ];

          for (const cmd of onCommands) {
            console.log(`   Trying: ${cmd.toString("hex")}`);
            await char.writeAsync(cmd, true);
            await new Promise((r) => setTimeout(r, 1500));
            const val = await char.readAsync();
            console.log(`   Result: ${val.toString("hex")}\n`);
          }
        } else if (command === "off") {
          console.log("\n🌙 Sending OFF commands...\n");

          const offCommands = [
            Buffer.from([0x00]),           // Simple off
            Buffer.from([0x00, 0x00]),     // Off + 0
            Buffer.from([0x00, 0x01]),     // Off + 1
          ];

          for (const cmd of offCommands) {
            console.log(`   Trying: ${cmd.toString("hex")}`);
            await char.writeAsync(cmd, true);
            await new Promise((r) => setTimeout(r, 1500));
            const val = await char.readAsync();
            console.log(`   Result: ${val.toString("hex")}\n`);
          }
        } else if (command === "raw") {
          // Send raw hex from argv[3]
          const hex = process.argv[3];
          if (!hex) {
            console.error("Usage: npx tsx src/ble-test.ts raw <hex>");
            process.exit(1);
          }
          const data = Buffer.from(hex, "hex");
          console.log(`\n📤 Sending: ${data.toString("hex")}`);
          await char.writeAsync(data, true);
          await new Promise((r) => setTimeout(r, 500));
          const val = await char.readAsync();
          console.log(`📥 Result: ${val.toString("hex")}`);
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
  }, 10000);
}

main();
