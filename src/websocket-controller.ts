/**
 * WebSocket Controller for Amaran Lights
 *
 * This script controls the Amaran light through the Amaran Desktop app's
 * WebSocket API. This requires the Amaran Desktop app to be running.
 *
 * Usage:
 *   npx tsx src/websocket-controller.ts list
 *   npx tsx src/websocket-controller.ts on [device-name]
 *   npx tsx src/websocket-controller.ts off [device-name]
 *   npx tsx src/websocket-controller.ts toggle [device-name]
 *   npx tsx src/websocket-controller.ts status [device-name]
 */

import WebSocket from "ws";
import { execSync } from "child_process";

// ============================================================================
// CONFIGURATION
// ============================================================================

const DEFAULT_WS_URL = "ws://localhost:60124";
const CLIENT_ID = "amaran-light-cli";
const COMMAND_TIMEOUT = 5000;

// ============================================================================

type CommandType =
  | "get_device_list"
  | "get_node_config"
  | "get_sleep"
  | "set_sleep"
  | "toggle_sleep"
  | "set_intensity"
  | "set_cct";

interface Command {
  version: number;
  client_id: string;
  type: CommandType;
  node_id?: string;
  args?: any;
}

interface Device {
  node_id: string;
  name: string;
  product_name?: string;
  online?: boolean;
}

class AmaranWebSocketController {
  private ws: WebSocket | null = null;
  private wsUrl: string;
  private devices: Device[] = [];
  private pendingCallbacks: Map<string, (success: boolean, data?: any) => void> = new Map();

  constructor(wsUrl: string = DEFAULT_WS_URL) {
    this.wsUrl = wsUrl;
  }

  /**
   * Discover the WebSocket port by checking the Amaran Desktop app
   * The app listens on multiple ports - we need the internal API port (usually 127.0.0.1)
   */
  static discoverPort(): string | null {
    try {
      // Use lsof to find the port the Amaran app is listening on
      // Look for the 127.0.0.1 listener which is the internal API
      const result = execSync(
        'lsof -i -P -n 2>/dev/null | grep -i "amaran" | grep LISTEN | grep "127.0.0.1" | awk \'{print $9}\' | cut -d: -f2 | head -1',
        { encoding: "utf-8" }
      ).trim();

      if (result && /^\d+$/.test(result)) {
        return `ws://127.0.0.1:${result}`;
      }

      // Fallback: try any amaran listener
      const fallback = execSync(
        'lsof -i -P -n 2>/dev/null | grep -i "amaran" | grep LISTEN | awk \'{print $9}\' | cut -d: -f2 | head -1',
        { encoding: "utf-8" }
      ).trim();

      if (fallback && /^\d+$/.test(fallback)) {
        return `ws://localhost:${fallback}`;
      }
    } catch (e) {
      // lsof might not find anything
    }
    return null;
  }

  async connect(): Promise<boolean> {
    // Try to discover the port first
    const discoveredUrl = AmaranWebSocketController.discoverPort();
    if (discoveredUrl) {
      this.wsUrl = discoveredUrl;
      console.log(`📡 Discovered Amaran app at ${this.wsUrl}`);
    }

    return new Promise((resolve) => {
      console.log(`🔗 Connecting to ${this.wsUrl}...`);

      this.ws = new WebSocket(this.wsUrl);

      const timeout = setTimeout(() => {
        console.error("❌ Connection timeout");
        console.error("");
        console.error("Make sure the Amaran Desktop app is running!");
        this.ws?.close();
        resolve(false);
      }, 5000);

      this.ws.on("open", () => {
        clearTimeout(timeout);
        console.log("✅ Connected to Amaran Desktop app\n");
        resolve(true);
      });

      this.ws.on("message", (data) => {
        try {
          const response = JSON.parse(data.toString());
          const requestType = response.request?.type;

          if (response.code !== 0) {
            console.error("Error from server:", response.message);
            if (requestType && this.pendingCallbacks.has(requestType)) {
              this.pendingCallbacks.get(requestType)?.(false);
              this.pendingCallbacks.delete(requestType);
            }
            return;
          }

          if (requestType && this.pendingCallbacks.has(requestType)) {
            this.pendingCallbacks.get(requestType)?.(true, response.data);
            this.pendingCallbacks.delete(requestType);
          }
        } catch (e) {
          console.error("Error parsing message:", e);
        }
      });

      this.ws.on("error", (error) => {
        clearTimeout(timeout);
        console.error("❌ WebSocket error:", error.message);
        console.error("");
        console.error("Make sure the Amaran Desktop app is running!");
        resolve(false);
      });

      this.ws.on("close", () => {
        // console.log("Disconnected from Amaran Desktop app");
      });
    });
  }

  private sendCommand(type: CommandType, nodeId?: string, args?: any): Promise<any> {
    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new Error("Not connected"));
        return;
      }

      const command: Command = {
        version: 1,
        client_id: CLIENT_ID,
        type,
        node_id: nodeId,
        args,
      };

      const timeout = setTimeout(() => {
        this.pendingCallbacks.delete(type);
        reject(new Error("Command timeout"));
      }, COMMAND_TIMEOUT);

      this.pendingCallbacks.set(type, (success, data) => {
        clearTimeout(timeout);
        if (success) {
          resolve(data);
        } else {
          reject(new Error("Command failed"));
        }
      });

      this.ws.send(JSON.stringify(command));
    });
  }

  async listDevices(): Promise<Device[]> {
    const data = await this.sendCommand("get_device_list");
    this.devices = data.data || [];
    return this.devices;
  }

  findDevice(nameOrId: string): Device | undefined {
    const searchLower = nameOrId.toLowerCase();
    return this.devices.find(
      (d) => d.node_id === nameOrId || d.name?.toLowerCase().includes(searchLower) || d.product_name?.toLowerCase().includes(searchLower)
    );
  }

  async turnOn(nodeId: string): Promise<void> {
    await this.sendCommand("set_sleep", nodeId, { sleep: false });
  }

  async turnOff(nodeId: string): Promise<void> {
    await this.sendCommand("set_sleep", nodeId, { sleep: true });
  }

  async toggle(nodeId: string): Promise<void> {
    await this.sendCommand("toggle_sleep", nodeId);
  }

  async getStatus(nodeId: string): Promise<any> {
    return await this.sendCommand("get_node_config", nodeId);
  }

  async setIntensity(nodeId: string, intensity: number): Promise<void> {
    await this.sendCommand("set_intensity", nodeId, { intensity });
  }

  async setCCT(nodeId: string, cct: number, intensity?: number): Promise<void> {
    const args: any = { cct };
    if (intensity !== undefined) {
      args.intensity = intensity;
    }
    await this.sendCommand("set_cct", nodeId, args);
  }

  disconnect(): void {
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Main
async function main() {
  const args = process.argv.slice(2);
  const command = args[0] || "list";
  const deviceName = args[1];

  const controller = new AmaranWebSocketController();

  try {
    const connected = await controller.connect();
    if (!connected) {
      process.exit(1);
    }

    // Always list devices first
    const devices = await controller.listDevices();

    if (command === "list") {
      console.log("📋 Available lights:\n");
      if (devices.length === 0) {
        console.log("No lights found. Make sure your light is connected in the Amaran app.");
      } else {
        for (const device of devices) {
          const online = device.online ? "🟢" : "🔴";
          console.log(`${online} ${device.name || device.product_name || "Unknown"}`);
          console.log(`   Node ID: ${device.node_id}`);
          console.log("");
        }
      }
      controller.disconnect();
      return;
    }

    // For other commands, find the device
    let targetDevice: Device | undefined;

    // Filter out the "All" group - we want actual lights
    const actualLights = devices.filter(
      (d) => d.name?.toLowerCase() !== "all" && d.product_name?.toLowerCase() !== "all"
    );

    if (deviceName) {
      targetDevice = controller.findDevice(deviceName);
      if (!targetDevice) {
        console.error(`❌ Device "${deviceName}" not found`);
        console.error("\nAvailable devices:");
        devices.forEach((d) => console.log(`  - ${d.name || d.product_name} (${d.node_id})`));
        controller.disconnect();
        process.exit(1);
      }
    } else if (actualLights.length === 1) {
      // If only one actual light (excluding "All" group), use it by default
      targetDevice = actualLights[0];
    } else if (actualLights.length > 1) {
      console.error("❌ Multiple lights found. Please specify a device name:");
      actualLights.forEach((d) => console.log(`  - ${d.name || d.product_name}`));
      controller.disconnect();
      process.exit(1);
    } else {
      console.error("❌ No lights found");
      controller.disconnect();
      process.exit(1);
    }

    console.log(`🎯 Target: ${targetDevice.name || targetDevice.product_name}\n`);

    switch (command) {
      case "on":
        console.log("💡 Turning light ON...");
        await controller.turnOn(targetDevice.node_id);
        console.log("✅ Light is ON");
        break;

      case "off":
        console.log("🌙 Turning light OFF...");
        await controller.turnOff(targetDevice.node_id);
        console.log("✅ Light is OFF");
        break;

      case "toggle":
        console.log("🔄 Toggling light...");
        await controller.toggle(targetDevice.node_id);
        console.log("✅ Light toggled");
        break;

      case "status":
        console.log("📊 Getting status...");
        const status = await controller.getStatus(targetDevice.node_id);
        console.log("\nLight Status:");
        console.log(JSON.stringify(status, null, 2));
        break;

      case "brightness":
        const brightness = parseInt(args[2] || "100", 10);
        console.log(`🔆 Setting brightness to ${brightness}%...`);
        await controller.setIntensity(targetDevice.node_id, brightness);
        console.log("✅ Brightness set");
        break;

      case "cct":
        const cct = parseInt(args[2] || "5600", 10);
        const intensity = args[3] ? parseInt(args[3], 10) : undefined;
        console.log(`🌡️  Setting color temperature to ${cct}K...`);
        await controller.setCCT(targetDevice.node_id, cct, intensity);
        console.log("✅ Color temperature set");
        break;

      default:
        console.log("Unknown command. Available commands:");
        console.log("  list                      - List all lights");
        console.log("  on [device]               - Turn light on");
        console.log("  off [device]              - Turn light off");
        console.log("  toggle [device]           - Toggle light");
        console.log("  status [device]           - Get light status");
        console.log("  brightness [device] [%]   - Set brightness (0-100)");
        console.log("  cct [device] [kelvin] [%] - Set color temperature");
    }
  } catch (error: any) {
    console.error("❌ Error:", error.message);
    process.exit(1);
  } finally {
    controller.disconnect();
  }
}

main().catch(console.error);
