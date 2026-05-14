#!/usr/bin/env npx tsx
/**
 * Amaran Light Daemon
 *
 * Stays connected to the lights over BLE and accepts commands via a Unix socket.
 * Start: npm run daemon:start  (or amaran start)
 * Stop:  npm run daemon:stop   (or amaran stop)
 */

import * as net from "net";
import * as http from "http";
import * as fs from "fs";
import * as path from "path";
import { SOCKET_PATH, PID_PATH } from "./daemon-paths.js";
import { loadConfig } from "./config.js";
import { MeshController } from "./mesh-controller.js";

export { SOCKET_PATH, PID_PATH } from "./daemon-paths.js";

async function runDaemon() {
  const config = loadConfig();
  const ctrl = new MeshController(config);

  // ── Connect ─────────────────────────────────────────────────────────────────
  console.log("Connecting to lights...");
  if (!(await ctrl.connect())) {
    console.error("Failed to connect. Is the Amaran Desktop app closed?");
    process.exit(1);
  }
  await ctrl.waitForBeacon(4000);
  await ctrl.setupProxyFilter();
  console.log("Ready. Listening on", SOCKET_PATH);

  // ── Clean up stale socket ────────────────────────────────────────────────────
  if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
  fs.writeFileSync(PID_PATH, String(process.pid));

  // ── Helper: resolve light address from key or "all" ─────────────────────────
  function resolveTargets(lightKey?: string): number[] {
    if (!lightKey || lightKey === "all") return [0xffff];
    const light = ctrl.lights.find(l => l.key === lightKey);
    if (!light) throw new Error(`Unknown light: "${lightKey}". Known: ${ctrl.lights.map(l => l.key).join(", ")}`);
    return [light.address];
  }

  // ── Run a command sent from a CLI client ─────────────────────────────────────
  async function runCommand(req: { cmd: string; args: string[]; light?: string }): Promise<string> {
    const { cmd, args, light } = req;
    const targets = resolveTargets(light);

    for (const addr of targets) {
      const lightName = ctrl.lights.find(l => l.address === addr)?.name ?? (addr === 0xffff ? "all" : `0x${addr.toString(16)}`);

      switch (cmd) {
        case "on":
          console.log(`Turning ${lightName} ON`);
          await ctrl.setOnOffBlast(addr, true);
          break;
        case "off":
          console.log(`Turning ${lightName} OFF`);
          await ctrl.setOnOffBlast(addr, false);
          break;
        case "brightness": {
          const pct = parseFloat(args[0]);
          if (isNaN(pct)) throw new Error("brightness requires a number 0-100");
          console.log(`${lightName} brightness → ${pct}%`);
          await ctrl.setBrightness(addr, pct);
          break;
        }
        case "cct": {
          const b = parseFloat(args[0]);
          const k = parseFloat(args[1]);
          const gm = args[2] ? parseFloat(args[2]) : 0;
          if (isNaN(b) || isNaN(k)) throw new Error("cct requires brightness and kelvin");
          console.log(`${lightName} CCT → ${b}%, ${k}K, GM ${gm}`);
          await ctrl.setCCT(addr, b, k, gm);
          break;
        }
        case "hsi":
        case "hsl": {
          const b = parseFloat(args[0]);
          const h = parseFloat(args[1]);
          const s = parseFloat(args[2]);
          if (isNaN(b) || isNaN(h) || isNaN(s)) throw new Error("hsi requires brightness, hue, saturation");
          console.log(`${lightName} HSI → ${b}%, hue ${h}°, sat ${s}%`);
          await ctrl.setHSL(addr, b, h, s);
          break;
        }
        case "ping":
          return "pong";
        case "stop":
          console.log("Stop requested. Disconnecting...");
          await ctrl.disconnect();
          cleanup();
          process.exit(0);
          break;
        case "lights":
          return JSON.stringify(ctrl.lights);
        default:
          throw new Error(`Unknown command: ${cmd}`);
      }
    }
    return "ok";
  }

  // ── Unix socket server ───────────────────────────────────────────────────────
  const server = net.createServer(socket => {
    let buf = "";
    socket.on("data", chunk => {
      buf += chunk.toString();
      const lines = buf.split("\n");
      buf = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        let req: any;
        try { req = JSON.parse(line); } catch {
          socket.write(JSON.stringify({ error: "Invalid JSON" }) + "\n");
          continue;
        }
        runCommand(req)
          .then(result => socket.write(JSON.stringify({ ok: true, result }) + "\n"))
          .catch(err => socket.write(JSON.stringify({ ok: false, error: err.message }) + "\n"));
      }
    });
    socket.on("error", () => {});
  });

  server.listen(SOCKET_PATH, () => {
    console.log(`Daemon PID ${process.pid} running`);
  });

  // ── HTTP REST server ─────────────────────────────────────────────────────────
  const httpCfg = config.http ?? { port: 2708, host: "0.0.0.0" };

  function readBody(req: http.IncomingMessage): Promise<any> {
    return new Promise((resolve, reject) => {
      let raw = "";
      req.on("data", c => { raw += c; });
      req.on("end", () => {
        if (!raw) { resolve({}); return; }
        try { resolve(JSON.parse(raw)); } catch { reject(new Error("Invalid JSON body")); }
      });
    });
  }

  function jsonResponse(res: http.ServerResponse, status: number, body: object) {
    res.writeHead(status, {
      "Content-Type": "application/json",
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    });
    res.end(JSON.stringify(body));
  }

  const httpServer = http.createServer(async (req, res) => {
    // CORS preflight
    if (req.method === "OPTIONS") { jsonResponse(res, 204, {}); return; }

    // Optional API key auth
    if (httpCfg.apiKey) {
      const authHeader = req.headers["authorization"] ?? "";
      if (authHeader !== `Bearer ${httpCfg.apiKey}`) {
        jsonResponse(res, 401, { ok: false, error: "Unauthorized" });
        return;
      }
    }

    const url = req.url ?? "/";
    const method = req.method ?? "GET";

    try {
      // GET / or GET /lights — list lights / health check
      if (method === "GET" && (url === "/" || url === "/lights")) {
        jsonResponse(res, 200, { ok: true, lights: ctrl.lights, daemon: true });
        return;
      }

      // Route: POST /lights/on  or  POST /lights/off
      const allMatch = url.match(/^\/lights\/(on|off)$/);
      if (method === "POST" && allMatch) {
        const result = await runCommand({ cmd: allMatch[1], args: [] });
        jsonResponse(res, 200, { ok: true, result });
        return;
      }

      // Route: POST /lights/:key/on|off|brightness|cct|hsi
      const lightMatch = url.match(/^\/lights\/([^/]+)\/([^/]+)$/);
      if (method === "POST" && lightMatch) {
        const [, lightKey, cmd] = lightMatch;
        const body = await readBody(req);
        let args: string[] = [];
        if (cmd === "brightness" && body.value !== undefined) args = [String(body.value)];
        if (cmd === "cct") args = [String(body.brightness ?? 80), String(body.kelvin ?? 5600), String(body.gm ?? 0)];
        if (cmd === "hsi" || cmd === "hsl") args = [String(body.brightness ?? 80), String(body.hue ?? 0), String(body.saturation ?? 100)];
        const result = await runCommand({ cmd, args, light: lightKey === "all" ? undefined : lightKey });
        jsonResponse(res, 200, { ok: true, result });
        return;
      }

      jsonResponse(res, 404, { ok: false, error: `No route for ${method} ${url}` });
    } catch (e: any) {
      jsonResponse(res, 400, { ok: false, error: e.message });
    }
  });

  httpServer.listen(httpCfg.port, httpCfg.host, () => {
    console.log(`HTTP API → http://${httpCfg.host === "0.0.0.0" ? "localhost" : httpCfg.host}:${httpCfg.port}`);
  });

  function cleanup() {
    if (fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  }

  const shutdown = async () => {
    httpServer.close();
    await ctrl.disconnect();
    cleanup();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT",  shutdown);
}

// Only run as daemon when this file is the main entry point, not when imported.
import { fileURLToPath } from "url";
if (process.argv[1] && (
  process.argv[1] === fileURLToPath(import.meta.url) ||
  process.argv[1].endsWith("daemon.ts") ||
  process.argv[1].endsWith("daemon.js")
)) {
  runDaemon().catch(err => {
    console.error("Daemon error:", err.message);
    process.exit(1);
  });
}
