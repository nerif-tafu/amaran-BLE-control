/**
 * Amaran Light Controller - Simple CLI wrapper
 * 
 * Controls Amaran 150c via WebSocket to the Desktop app.
 * Auto-starts the app if not running.
 * 
 * Usage:
 *   npx tsx src/amaran-control.ts on        # Turn on
 *   npx tsx src/amaran-control.ts off       # Turn off (sleep mode)
 *   npx tsx src/amaran-control.ts toggle    # Toggle on/off
 *   npx tsx src/amaran-control.ts brightness 50  # Set 50%
 *   npx tsx src/amaran-control.ts cct 5600       # Set color temp
 *   npx tsx src/amaran-control.ts status         # Show current state
 */

import WebSocket from "ws";
import { execSync, spawn } from "child_process";

const CLIENT_ID = "amaran-light-cli";
const COMMAND_TIMEOUT = 5000;

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
  online?: boolean;
}

class AmaranController {
  private ws: WebSocket | null = null;
  private wsUrl: string = "";
  private devices: Device[] = [];
  private pendingCallbacks: Map<string, (success: boolean, data?: any) => void> = new Map();

  /**
   * Discover the WebSocket port
   */
  private discoverPort(): string | null {
    try {
      const result = execSync(
        'lsof -i -P -n 2>/dev/null | grep -i "amaran" | grep LISTEN | grep "127.0.0.1" | awk \'{print $9}\' | cut -d: -f2 | head -1',
        { encoding: "utf-8" }
      ).trim();

      if (result && /^\d+$/.test(result)) {
        return `ws://127.0.0.1:${result}`;
      }
    } catch {}
    return null;
  }

  /**
   * Check if app is running
   */
  private isAppRunning(): boolean {
    try {
      const result = execSync("pgrep -f 'amaran Desktop'", { encoding: "utf-8" });
      return result.trim().length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Start the app and wait for it
   */
  private async startApp(): Promise<void> {
    console.log("🚀 Starting Amaran Desktop app...");
    
    spawn("open", ["-a", "amaran Desktop"], {
      detached: true,
      stdio: "ignore"
    }).unref();

    for (let i = 0; i < 30; i++) {
      await this.sleep(1000);
      if (this.discoverPort()) {
        console.log("✅ App started");
        return;
      }
      if (i % 5 === 4) console.log(`   Waiting... (${i + 1}s)`);
    }
    throw new Error("App failed to start within 30 seconds");
  }

  async connect(): Promise<boolean> {
    if (!this.isAppRunning()) {
      await this.startApp();
    }

    const url = this.discoverPort();
    if (!url) {
      console.error("❌ Could not find Amaran app");
      return false;
    }
    this.wsUrl = url;

    return new Promise((resolve) => {
      this.ws = new WebSocket(this.wsUrl);

      const timeout = setTimeout(() => {
        this.ws?.close();
        resolve(false);
      }, 5000);

      this.ws.on("open", async () => {
        clearTimeout(timeout);
        console.log("✅ Connected to Amaran Desktop\n");
        
        // Get devices
        this.devices = await this.getDevices();
        resolve(true);
      });

      this.ws.on("message", (data: Buffer) => {
        try {
          const response = JSON.parse(data.toString());
          const requestType = response.request?.type;

          if (response.code === 0 && requestType && this.pendingCallbacks.has(requestType)) {
            this.pendingCallbacks.get(requestType)?.(true, response.data);
            this.pendingCallbacks.delete(requestType);
          } else if (response.code !== 0 && requestType && this.pendingCallbacks.has(requestType)) {
            this.pendingCallbacks.get(requestType)?.(false);
            this.pendingCallbacks.delete(requestType);
          }
        } catch {}
      });

      this.ws.on("error", (err) => {
        clearTimeout(timeout);
        console.error("WebSocket error:", err.message);
        resolve(false);
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

      this.pendingCallbacks.set(type, (success, data) => {
        resolve(success ? data : null);
      });

      this.ws.send(JSON.stringify(command));

      setTimeout(() => {
        if (this.pendingCallbacks.has(type)) {
          this.pendingCallbacks.delete(type);
          resolve(null);
        }
      }, COMMAND_TIMEOUT);
    });
  }

  async getDevices(): Promise<Device[]> {
    const data = await this.sendCommand("get_device_list");
    return data?.data || [];
  }

  private getFirstDevice(): Device | null {
    // Return first actual device (prefer ones with names, skip "All" groups)
    return this.devices.find(d => d.name && !d.name.toLowerCase().includes("all")) || this.devices[0] || null;
  }

  async turnOn(): Promise<void> {
    const device = this.getFirstDevice();
    if (!device) { console.error("❌ No light found"); return; }
    
    console.log(`💡 Turning ${device.name || device.node_id} ON...`);
    await this.sendCommand("set_sleep", device.node_id, { sleep: false });
    console.log("✅ Light is ON");
  }

  async turnOff(): Promise<void> {
    const device = this.getFirstDevice();
    if (!device) { console.error("❌ No light found"); return; }
    
    console.log(`💤 Turning ${device.name || device.node_id} OFF...`);
    await this.sendCommand("set_sleep", device.node_id, { sleep: true });
    console.log("✅ Light is OFF");
  }

  async toggle(): Promise<void> {
    const device = this.getFirstDevice();
    if (!device) { console.error("❌ No light found"); return; }
    
    console.log(`🔄 Toggling ${device.name || device.node_id}...`);
    await this.sendCommand("toggle_sleep", device.node_id);
    console.log("✅ Light toggled");
  }

  async setBrightness(percent: number): Promise<void> {
    const device = this.getFirstDevice();
    if (!device) { console.error("❌ No light found"); return; }
    
    const intensity = Math.max(0, Math.min(100, percent)) * 10;
    console.log(`🔆 Setting brightness to ${percent}%...`);
    await this.sendCommand("set_intensity", device.node_id, { intensity });
    console.log(`✅ Brightness set to ${percent}%`);
  }

  async setCCT(kelvin: number): Promise<void> {
    const device = this.getFirstDevice();
    if (!device) { console.error("❌ No light found"); return; }
    
    const cct = Math.max(25, Math.min(75, Math.round(kelvin / 100)));
    console.log(`🎨 Setting color temperature to ${kelvin}K...`);
    await this.sendCommand("set_cct", device.node_id, { cct });
    console.log(`✅ Color temperature set to ${kelvin}K`);
  }

  async getStatus(): Promise<void> {
    const device = this.getFirstDevice();
    if (!device) { console.error("❌ No light found"); return; }
    
    console.log(`📊 ${device.name || device.node_id}:`);
    
    const sleepData = await this.sendCommand("get_sleep", device.node_id);
    if (sleepData) {
      console.log(`   Power: ${sleepData.sleep ? "OFF (sleep)" : "ON"}`);
    }
    
    const config = await this.sendCommand("get_node_config", device.node_id);
    if (config) {
      console.log(`   Intensity: ${(config.intensity || 0) / 10}%`);
      console.log(`   CCT: ${(config.cct || 0) * 100}K`);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }

  disconnect(): void {
    this.ws?.close();
  }
}

async function main() {
  const [,, command, value] = process.argv;

  const controller = new AmaranController();

  if (!(await controller.connect())) {
    console.error("❌ Failed to connect to Amaran Desktop");
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
      case "brightness":
      case "b":
        if (!value) { console.log("Usage: brightness <0-100>"); break; }
        await controller.setBrightness(parseInt(value, 10));
        break;
      case "cct":
      case "temp":
        if (!value) { console.log("Usage: cct <2500-7500>"); break; }
        await controller.setCCT(parseInt(value, 10));
        break;
      case "status":
        await controller.getStatus();
        break;
      default:
        console.log(`
Amaran Light Controller
=======================

Commands:
  on              Turn light on
  off             Turn light off (sleep mode)
  toggle          Toggle on/off
  brightness <n>  Set brightness (0-100%)
  cct <kelvin>    Set color temperature (2500-7500K)
  status          Show current status

Examples:
  npx tsx src/amaran-control.ts on
  npx tsx src/amaran-control.ts brightness 75
  npx tsx src/amaran-control.ts cct 5600
        `);
    }
  } finally {
    controller.disconnect();
  }
}

main().catch(console.error);
