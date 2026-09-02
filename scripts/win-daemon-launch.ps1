# Boot entry point for the amaran daemon, registered by `npm run autostart:install`.
#
# Task Scheduler runs this via `powershell -WindowStyle Hidden`, and node
# inherits that hidden console, so the daemon runs with no visible window.
#
# This script supervises the daemon rather than just launching it: Task
# Scheduler's own restart-on-failure only fires when a task ends unexpectedly,
# not when its action exits non-zero, so a daemon that gives up because the
# light is off at boot would otherwise never be retried.
#
# Output goes to %TEMP%\amaran-light.log -- the same log `amaran start` writes,
# and the only way to see why a boot-time start failed.

param(
  [string]$Node = '',
  [int]$RetrySeconds = 60
)

$ErrorActionPreference = 'Stop'

$repo = Split-Path -Parent $PSScriptRoot
Set-Location $repo

$logPath = Join-Path ([System.IO.Path]::GetTempPath()) 'amaran-light.log'
$maxLogBytes = 1MB

# FileShare.ReadWrite so the log can still be read (Get-Content, tail) while the
# daemon holds it open, which is most of the time.
function Open-Log {
  $stream = [System.IO.File]::Open($logPath, 'Append', 'Write', 'ReadWrite')
  # UTF-8 without BOM: the daemon's output contains non-ASCII (arrows, box
  # drawing), which the default ANSI encoding mangles.
  $writer = New-Object System.IO.StreamWriter($stream, (New-Object System.Text.UTF8Encoding($false)))
  $writer.AutoFlush = $true
  return $writer
}

$log = Open-Log

function Write-Log([string]$Message) {
  $log.WriteLine(("[{0}] {1}" -f (Get-Date -Format 'yyyy-MM-dd HH:mm:ss'), $Message))
}

try {
  if (-not $Node) { $Node = (Get-Command node -ErrorAction SilentlyContinue).Source }
  if (-not $Node) { Write-Log 'node was not found on PATH'; exit 1 }

  $compiled = Join-Path $repo 'dist/daemon.js'
  if (Test-Path $compiled) {
    $argv = @($compiled)
  } else {
    $argv = @((Join-Path $repo 'node_modules/tsx/dist/cli.mjs'), (Join-Path $repo 'src/daemon.ts'))
  }

  while ($true) {
    if ($log.BaseStream.Length -gt $maxLogBytes) {
      $log.Dispose()
      Remove-Item $logPath -Force -ErrorAction SilentlyContinue
      $log = Open-Log
    }

    Write-Log "starting: $Node $($argv -join ' ')"

    # Under 'Stop', PowerShell turns a native command's stderr into a
    # terminating error and kills this script mid-run, losing both the daemon's
    # output and its exit code -- so relax it around the call itself.
    $ErrorActionPreference = 'Continue'
    # The daemon writes UTF-8; without this PowerShell decodes its output
    # using the console's OEM code page and mangles every non-ASCII glyph.
    [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
    & $Node @argv 2>&1 | ForEach-Object { $log.WriteLine($_.ToString()) }
    $code = $LASTEXITCODE
    $ErrorActionPreference = 'Stop'

    Write-Log "daemon exited with code $code"

    # Exit 0 means a deliberate shutdown (`amaran stop`) -- stay stopped.
    if ($code -eq 0) { break }

    Write-Log "retrying in $RetrySeconds seconds"
    Start-Sleep -Seconds $RetrySeconds
  }
  exit 0
} finally {
  $log.Dispose()
}
