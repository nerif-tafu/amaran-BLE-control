#!/usr/bin/env npx tsx
/*
 * Start the amaran daemon automatically at logon.
 *
 *   npm run autostart:install     register the Scheduled Task
 *   npm run autostart:uninstall   remove it
 *   npm run autostart:status      show its state and last run result
 *   npm run autostart:start       run it now, without waiting for a logon
 *
 * The task runs as the current user with an interactive token: noble's
 * Bluetooth backend on Windows is WinRT, which is not available to session-0
 * services, so this cannot be a Windows service.
 */
import { execFileSync } from "child_process";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { fileURLToPath } from "url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..");
const LAUNCHER = path.join(HERE, "win-daemon-launch.ps1");
const TASK_NAME = "Amaran Light Daemon";

// Windows PowerShell 5.1 — always present at a fixed path, unlike pwsh.
const PS_HOST = path.join(
  process.env.SystemRoot ?? "C:/Windows",
  "System32", "WindowsPowerShell", "v1.0", "powershell.exe",
);
const PS_HOST_NAME = `"${PS_HOST}"`;

// Console host, used to run the launcher windowless. See the note in install().
const CONHOST = path.join(
  process.env.SystemRoot ?? "C:/Windows",
  "System32", "conhost.exe",
);

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}

/** Quote a value for embedding in a single-quoted PowerShell string. */
function ps(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Run a PowerShell script. Passed as a file rather than -Command so that paths
 * containing spaces survive without another layer of quoting.
 */
function runPowerShell(script: string): string {
  const tmp = path.join(os.tmpdir(), `amaran-autostart-${process.pid}.ps1`);
  fs.writeFileSync(tmp, script, "utf-8");
  try {
    return execFileSync(
      PS_HOST,
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", tmp],
      { encoding: "utf-8", stdio: ["ignore", "pipe", "inherit"] },
    ).trim();
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function install(): void {
  if (!fs.existsSync(path.join(REPO_ROOT, "lights.json"))) {
    die("lights.json not found. Run `npm run setup` first — the daemon needs it at startup.");
  }
  // `powershell -WindowStyle Hidden` is NOT enough on Windows 11. When Windows
  // Terminal is the default terminal application, conhost hands the console off
  // to a separate WindowsTerminal.exe process, and PowerShell cannot hide a
  // window it does not own -- a black terminal sits on screen for as long as the
  // daemon runs. Launching under `conhost --headless` opts out of that handoff
  // and gives the process a console with no window at all.
  const args = [
    "--headless",
    PS_HOST_NAME,
    "-NoProfile", "-ExecutionPolicy", "Bypass", "-WindowStyle", "Hidden",
    "-File", `"${LAUNCHER}"`, "-Node", `"${process.execPath}"`,
  ].join(" ");

  runPowerShell(`
$ErrorActionPreference = 'Stop'
$user = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name

$action = New-ScheduledTaskAction -Execute ${ps(CONHOST)} -Argument ${ps(args)} -WorkingDirectory ${ps(REPO_ROOT)}

# A short delay lets the Bluetooth stack finish coming up before the daemon scans.
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$trigger.Delay = 'PT30S'

# A backstop only: Task Scheduler applies this when the task ends
# unexpectedly, not when the action exits non-zero. Retrying a daemon that
# could not reach the light is the launcher script's job.
$settings = New-ScheduledTaskSettingsSet \`
  -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries \`
  -StartWhenAvailable \`
  -DontStopOnIdleEnd \`
  -ExecutionTimeLimit ([TimeSpan]::Zero) \`
  -RestartInterval (New-TimeSpan -Minutes 1) -RestartCount 99 \`
  -MultipleInstances IgnoreNew

$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName ${ps(TASK_NAME)} \`
  -Description 'Keeps the Amaran BLE mesh daemon connected and serving its local API.' \`
  -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

"Registered as user $user"
`);
  console.log(`Installed scheduled task "${TASK_NAME}".`);
  console.log(`  Runs at logon (30s delay), working directory ${REPO_ROOT}`);
  console.log(`  Start it now without rebooting:  npm run autostart:start`);
}

function uninstall(): void {
  runPowerShell(`
$ErrorActionPreference = 'Stop'
if (Get-ScheduledTask -TaskName ${ps(TASK_NAME)} -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName ${ps(TASK_NAME)} -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName ${ps(TASK_NAME)} -Confirm:$false
}
`);
  console.log(`Removed scheduled task "${TASK_NAME}".`);
}

function status(): void {
  const out = runPowerShell(`
$t = Get-ScheduledTask -TaskName ${ps(TASK_NAME)} -ErrorAction SilentlyContinue
if (-not $t) { 'Not installed. Run: npm run autostart:install'; exit 0 }
$i = Get-ScheduledTaskInfo -TaskName ${ps(TASK_NAME)}
"State:       $($t.State)"
"Last run:    $($i.LastRunTime)"
"Last result: 0x$('{0:X8}' -f $i.LastTaskResult)"
"Next run:    $($i.NextRunTime)"
"Command:     $($t.Actions[0].Execute) $($t.Actions[0].Arguments)"
`);
  console.log(out);
}

function startNow(): void {
  runPowerShell(`
$ErrorActionPreference = 'Stop'
Start-ScheduledTask -TaskName ${ps(TASK_NAME)}
`);
  console.log(`Started "${TASK_NAME}".`);
}

function main(): void {
  if (process.platform !== "win32") {
    die(`autostart is implemented for Windows only (this is ${process.platform}).\nOn macOS use a launchd agent; on Linux a systemd --user unit.`);
  }
  const cmd = process.argv[2] ?? "status";
  switch (cmd) {
    case "install":   install();   break;
    case "uninstall": uninstall(); break;
    case "status":    status();    break;
    case "start":     startNow();  break;
    default: die(`Unknown command: ${cmd}\nUsage: autostart <install|uninstall|status|start>`);
  }
}

main();
