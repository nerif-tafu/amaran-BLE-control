#!/usr/bin/env npx tsx
/**
 * Amaran Light Controller
 *
 * Simple CLI to control your Amaran 150c light.
 * Automatically manages the Amaran Desktop app.
 *
 * Usage:
 *   ./src/amaran.ts on
 *   ./src/amaran.ts off
 *   ./src/amaran.ts toggle
 *   ./src/amaran.ts status
 *   ./src/amaran.ts brightness 75
 *   ./src/amaran.ts cct 5600
 */

import WebSocket from "ws";
import { execSync, spawn } from "child_process";

const CLIENT_ID = "amaran-light-cli";
const COMMAND_TIMEOUT = 5000;
const APP_PATH = "/Applications/amaran Desktop.app";

interface Device {
  node_id: string;
  name: string;
  product_name?: string;
  online?: boolean;
}

/**
 * Check if Amaran Desktop app is running
 */
function isAppRunning(): boolean {
  try {
    const result = execSync('pgrep -f "amaran Desktop"', { encoding: "utf-8" });
    return result.trim().length > 0;
  } catch {
    return false;
  }
}

/**
 * Start the Amaran Desktop app
 */
async function startApp(): Promise<boolean> {
  console.log("🚀 Starting Amaran Desktop app...");

  spawn("open", ["-a", APP_PATH], { detached: true, stdio: "ignore" });

  // Wait for app to start and WebSocket to become available
  for (let i = 0; i < 30; i++) {
    await sleep(1000);
    const port = discoverPort();
    if (port) {
      console.log("✅ Amaran Desktop app started");
      return true;
    }
  }

  console.error("❌ Failed to start Amaran Desktop app");
  return false;
}

/**
 * Discover the WebSocket port
 */
function discoverPort(): string | null {
  try {
    const result = execSync(
      'lsof -i -P -n 2>/dev/null | grep -i "amaran" | grep LISTEN | grep "127.0.0.1" | awk \'{print $9}\' | cut -d: -f2 | head -1',
      { encoding: "utf-8" }
    ).trim();

    if (result && /^\d+$/.test(result)) {
      return result;
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * Connect and execute a command
 */
async function executeCommand(
  action: string,
  args: any = {}
): Promise<{ success: boolean; data?: any }> {
  // Ensure app is running
  if (!isAppRunning()) {
    const started = await startApp();
    if (!started) {
      return { success: false };
    }
  }

  const port = discoverPort();
  if (!port) {
    console.error("❌ Could not find Amaran Desktop WebSocket port");
    return { success: false };
  }

  const wsUrl = `ws://127.0.0.1:${port}`;

  return new Promise((resolve) => {
    const ws = new WebSocket(wsUrl);
    let deviceNodeId: string | null = null;

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ success: false });
    }, COMMAND_TIMEOUT);

    ws.on("error", () => {
      clearTimeout(timeout);
      resolve({ success: false });
    });

    ws.on("open", () => {
      // First get device list
      ws.send(
        JSON.stringify({
          version: 1,
          client_id: CLIENT_ID,
          type: "get_device_list",
          args: {},
        })
      );
    });

    ws.on("message", (data) => {
      try {
        const response = JSON.parse(data.toString());

        if (response.code !== 0) {
          clearTimeout(timeout);
          ws.close();
          resolve({ success: false });
          return;
        }

        const requestType = response.request?.type;

        if (requestType === "get_device_list") {
          const devices: Device[] = response.data?.data || [];
          // Find the first actual light (not "All" group)
          const light = devices.find(
            (d) =>
              d.name?.toLowerCase() !== "all" &&
              d.product_name?.toLowerCase() !== "all"
          );

          if (!light) {
            console.error("❌ No light found");
            clearTimeout(timeout);
            ws.close();
            resolve({ success: false });
            return;
          }

          deviceNodeId = light.node_id;

          // Now send the actual command
          ws.send(
            JSON.stringify({
              version: 1,
              client_id: CLIENT_ID,
              type: action,
              node_id: deviceNodeId,
              args,
            })
          );
        } else {
          // This is the response to our actual command
          clearTimeout(timeout);
          ws.close();
          resolve({ success: true, data: response.data });
        }
      } catch {
        clearTimeout(timeout);
        ws.close();
        resolve({ success: false });
      }
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Main
async function main() {
  const command = process.argv[2] || "status";
  const arg1 = process.argv[3];
  const arg2 = process.argv[4];

  let result: { success: boolean; data?: any };

  switch (command) {
    case "on":
      console.log("💡 Turning light ON...");
      result = await executeCommand("set_sleep", { sleep: false });
      if (result.success) console.log("✅ Light is ON");
      break;

    case "off":
      console.log("🌙 Turning light OFF...");
      result = await executeCommand("set_sleep", { sleep: true });
      if (result.success) console.log("✅ Light is OFF");
      break;

    case "toggle":
      console.log("🔄 Toggling light...");
      result = await executeCommand("toggle_sleep");
      if (result.success) console.log("✅ Light toggled");
      break;

    case "status":
      result = await executeCommand("get_node_config");
      if (result.success) {
        console.log("📊 Light status:");
        console.log(JSON.stringify(result.data, null, 2));
      }
      break;

    case "brightness":
    case "intensity":
      const intensity = parseInt(arg1 || "100", 10);
      console.log(`🔆 Setting brightness to ${intensity}%...`);
      result = await executeCommand("set_intensity", { intensity: intensity * 10 });
      if (result.success) console.log(`✅ Brightness set to ${intensity}%`);
      break;

    case "cct":
      const cct = parseInt(arg1 || "5600", 10);
      const cctIntensity = arg2 ? parseInt(arg2, 10) * 10 : undefined;
      console.log(`🌡️  Setting color temperature to ${cct}K...`);
      result = await executeCommand("set_cct", {
        cct,
        intensity: cctIntensity,
      });
      if (result.success) console.log(`✅ Color temperature set to ${cct}K`);
      break;

    default:
      console.log(`
Amaran Light Controller

Usage:
  npx tsx src/amaran.ts <command> [args]

Commands:
  on                  Turn light on
  off                 Turn light off
  toggle              Toggle light on/off
  status              Get light configuration
  brightness <0-100>  Set brightness percentage
  cct <kelvin> [%]    Set color temperature (2500-7500K)

Examples:
  npx tsx src/amaran.ts on
  npx tsx src/amaran.ts brightness 75
  npx tsx src/amaran.ts cct 5600 80
`);
      process.exit(0);
  }

  if (!result!.success) {
    console.error("❌ Command failed");
    process.exit(1);
  }
}

main().catch(console.error);
