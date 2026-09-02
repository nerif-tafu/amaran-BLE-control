import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";

export const IS_WINDOWS = process.platform === "win32";

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** Repo root — the daemon must run from here, since lights.json is read from cwd. */
export const REPO_ROOT = path.resolve(HERE, "..");

// Windows has no Unix domain sockets. Node's net module accepts a named pipe
// path in their place; the pipe lives in the kernel's pipe namespace rather
// than on disk, so it needs no cleanup and cannot be left stale by a crash.
export const SOCKET_PATH = IS_WINDOWS
  ? "\\\\.\\pipe\\amaran-light"
  : path.join(os.tmpdir(), "amaran-light.sock");

export const PID_PATH = path.join(os.tmpdir(), "amaran-light.pid");
export const LOG_PATH = path.join(os.tmpdir(), "amaran-light.log");

/**
 * PID of the running daemon, or null if there isn't one.
 *
 * Liveness comes from the PID file rather than the socket file: a named pipe
 * isn't visible on disk, and a socket file outlives a crashed daemon.
 */
export function daemonPid(): number | null {
  let pid: number;
  try {
    pid = parseInt(fs.readFileSync(PID_PATH, "utf-8").trim(), 10);
  } catch {
    return null;
  }
  if (!pid) return null;
  try {
    process.kill(pid, 0); // signal 0 tests for existence without signalling
    return pid;
  } catch (e: any) {
    // EPERM means the process exists but belongs to someone else.
    return e?.code === "EPERM" ? pid : null;
  }
}

export function isDaemonRunning(): boolean {
  return daemonPid() !== null;
}

export function cleanupDaemonFiles(): void {
  try {
    if (!IS_WINDOWS && fs.existsSync(SOCKET_PATH)) fs.unlinkSync(SOCKET_PATH);
    if (fs.existsSync(PID_PATH)) fs.unlinkSync(PID_PATH);
  } catch { /* best effort */ }
}

/**
 * How to launch the daemon: compiled JS if this build was compiled, otherwise
 * node with the tsx loader over the TypeScript source.
 */
export function daemonCommand(): { command: string; args: string[] } {
  const compiled = path.join(HERE, "daemon.js");
  if (!HERE.endsWith("src") && fs.existsSync(compiled)) {
    return { command: process.execPath, args: [compiled] };
  }
  const require = createRequire(import.meta.url);
  return {
    command: process.execPath,
    args: [require.resolve("tsx/cli"), path.join(HERE, "daemon.ts")],
  };
}
