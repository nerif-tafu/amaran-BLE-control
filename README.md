# Amaran Light Controller

Wifi + Direct Bluetooth Mesh control of Amaran studio lights — **no Amaran Desktop app required**.

Two ways to drive the lights:

- **macOS / Node.js** (this repo's `src/`) — control from your Mac over BLE. See below.
- **ESP32 standalone node** ([`esp32-firmware/`](esp32-firmware/README.md)) — a
  always-on hardware bridge that joins the mesh and exposes the lights to
  **Home Assistant (MQTT)** and an **HTTP API**, no Mac required at runtime.

## Quick Start

```bash
npm install
npm run setup        # reads your amaran.db and writes lights.json (one time)

# Slow path (~10s startup per command, no daemon needed):
npm run mesh:on
npm run mesh:off

# Fast path (~0.6s per command):
npm run daemon:start    # connect once, stay connected
npm run mesh:on         # instant
npm run mesh:brightness 75
npm run mesh:off
npm run daemon:stop
```

## Setup

`npm run setup` finds the amaran Desktop app's database and writes a
`lights.json` config file. Run it once after installing. It looks in:

- macOS: `~/Library/Application Support/amaran Desktop/*/amaran.db`
- Windows: `%APPDATA%\amaran Desktop\*\amaran.db` (also `%LOCALAPPDATA%`)
- Linux: `~/.config/amaran Desktop/*/amaran.db`

If the Amaran app isn't installed, run setup and enter your mesh keys manually.

## Commands

```bash
npx tsx src/cli.ts on
npx tsx src/cli.ts off
npx tsx src/cli.ts brightness 75
npx tsx src/cli.ts cct 80 5600          # 80% brightness, 5600K
npx tsx src/cli.ts cct 80 5600 15       # with GM +15 (green bias)
npx tsx src/cli.ts hsi 80 45 60         # hue 45°, saturation 60%

# Target a specific light:
npx tsx src/cli.ts brightness 50 key
npx tsx src/cli.ts on back
npx tsx src/cli.ts off halo

# Daemon management:
npx tsx src/cli.ts start    # start background daemon
npx tsx src/cli.ts stop     # stop daemon
npx tsx src/cli.ts lights   # list configured lights

# Interactive REPL (keeps connection open):
npx tsx src/cli.ts
```

Or use the npm shortcuts: `mesh:on`, `mesh:off`, `mesh:brightness`, `mesh:cct`, `mesh:hsi`.

## npm Scripts

| Script                   | Description                                                |
| ------------------------ | ---------------------------------------------------------- |
| `setup`                  | Run setup wizard (one time)                                |
| `daemon:start`           | Start daemon (also serves HTTP + MQTT if configured)       |
| `daemon:stop`            | Stop daemon                                                |
| `autostart:install`      | Windows: start the daemon at logon (Scheduled Task)        |
| `autostart:uninstall`    | Windows: remove the logon task                             |
| `autostart:status`       | Windows: task state, last run time and exit code           |
| `autostart:start`        | Windows: run the logon task now, without rebooting         |
| `mesh:on`                | Turn all lights on                                         |
| `mesh:off`               | Turn all lights off                                        |
| `mesh:brightness <n>`    | Set brightness 0-100                                       |
| `mesh:cct <b> <k> [gm]`  | CCT: brightness 0-100, kelvin 2500-7500, GM -10..+10       |
| `mesh:hsi <b> <h> <s>`   | HSI: brightness, hue 0-360°, saturation 0-100              |
| `scan`                   | Scan for BLE devices                                       |
| `discover <addr>`        | Inspect a device's services                                |
| `gen-config`             | Write `esp32-firmware/main/mesh_config.h` from `amaran.db` |
| `mqtt:watch`             | Subscribe to the `amaran/.../state` topics                 |
| `esp32:probe -- "<cmd>"` | Send a REPL command to the ESP32, decode its replies       |
| `esp32:capture`          | Trigger a refresh on the ESP32, dump raw serial            |

After any command, the controller now also sends a Telink status-request so
fixtures broadcast their new state immediately — the ESP32 bridge and the
desktop app pick up the change right away instead of on the next poll.

## Running at Boot (Windows)

```bash
npm run autostart:install
```

Registers a Scheduled Task that starts the daemon 30 seconds after you log in,
with no console window and the working directory set to this repo.

The task runs [`scripts/win-daemon-launch.ps1`](scripts/win-daemon-launch.ps1),
which supervises the daemon rather than just launching it: if the daemon exits
non-zero — the usual case when the light is powered off or out of range at
boot — it is restarted every 60 seconds until it comes up. A clean exit (from
`amaran stop`) ends the loop, so stopping the daemon keeps it stopped.
Task Scheduler's own restart-on-failure setting does not cover this: it fires
when a task ends unexpectedly, not when its action returns a non-zero code.

```bash
npm run autostart:status
```

shows the task state and the last exit code; `npm run autostart:uninstall`
removes it. Boot-time output goes to `%TEMP%\amaran-light.log`.

It has to be a logon task rather than a Windows service: noble talks to the
Bluetooth adapter through WinRT, which is not available to session-0 services.
That also means the daemon only runs while you are logged in.

On macOS and Linux the same job needs a launchd agent or a `systemd --user`
unit; `autostart:install` refuses to run there rather than pretending.

## How It Works

**`src/cli.ts`** — main entry point. If the daemon is running, sends commands
over a Unix socket (instant). Otherwise connects directly (slow startup).

**`src/daemon.ts`** — background process that stays BLE-connected and accepts
commands via `/tmp/amaran-light.sock`. Start with `npm run daemon:start`.

**`src/mesh-controller.ts`** — full BLE Mesh stack (crypto, proxy protocol,
command encoding). All physical controls use **Telink proprietary opcode `0x26`**,
originally reverse-engineered from the amaran Desktop app's PyMeshSDK and now
implemented natively here (and in the ESP32 firmware's `telink.c`).

**`src/setup.ts`** — reads `amaran.db` to extract mesh keys and light addresses,
writes `lights.json`.

Standard BLE Mesh models (Generic OnOff, Light Lightness) respond correctly but
are decoupled from the physical LED output. Opcode `0x26` is what actually
controls sleep/wake, brightness, CCT, and HSI.

## Config (`lights.json`)

Generated by `npm run setup`. Gitignored — each user generates their own.

```json
{
  "netKey": "...",
  "appKey": "...",
  "relayHub": "A4:C1:38:13:41:38",
  "lights": [
    {
      "key": "key",
      "name": "Key Light",
      "mac": "A4:C1:38:13:41:38",
      "address": 2
    },
    {
      "key": "back",
      "name": "Back Light",
      "mac": "A4:C1:38:13:30:86",
      "address": 4
    },
    {
      "key": "halo",
      "name": "Halo 100x",
      "mac": "A4:C1:38:56:8C:EF",
      "address": 6
    }
  ]
}
```

See `lights.example.json` for the template.

## Command Payload Format (opcode `0x26`)

All commands use a 10-byte payload: `[checksum, ...packed_bits..., cmd_value, cmd_type]`

| Mode       | `cmd_type` | Notes                                                           |
| ---------- | ---------- | --------------------------------------------------------------- |
| On/Off     | `0x8C`     | `byte[8]` = 0x01 on / 0x00 off                                  |
| Brightness | `0x8F`     | intensity 0-1000; low 2 bits at `byte[7]`, upper 8 at `byte[8]` |
| CCT        | `0x82`     | kelvin packed as `(k+24)&0x3FF` at bits 52-61; GM at bits 43-51 |
| HSI        | `0x81`     | hue (9 bits) at bits 53-61; saturation (7 bits) at bits 46-52   |

See `DIRECT-BLE-CONTROL.md` for full reverse-engineering notes.

---

## HTTP REST API

When the daemon is running, a REST API is available at `http://localhost:2708`
(configurable via `lights.json`).

```bash
# List lights / health check
curl http://localhost:2708/

# Turn all on/off
curl -X POST http://localhost:2708/lights/on
curl -X POST http://localhost:2708/lights/off

# Target a specific light (use key from lights.json)
curl -X POST http://localhost:2708/lights/keylight/on
curl -X POST http://localhost:2708/lights/keylight/brightness \
  -H 'Content-Type: application/json' -d '{"value": 75}'

curl -X POST http://localhost:2708/lights/all/cct \
  -H 'Content-Type: application/json' \
  -d '{"brightness": 80, "kelvin": 5600, "gm": 10}'

curl -X POST http://localhost:2708/lights/all/hsi \
  -H 'Content-Type: application/json' \
  -d '{"brightness": 80, "hue": 45, "saturation": 60}'
```

Configure port and optional API key in `lights.json`:

```json
{
  "http": { "port": 2708, "host": "0.0.0.0", "apiKey": "my-secret" }
}
```

## Home Assistant Integration

Via MQTT discovery:

1. Install Mosquitto on the HA host (Add-on store)
2. Add to `lights.json`:

```json
{
  "mqtt": {
    "broker": "mqtt://homeassistant.local:1883",
    "username": "...",
    "password": "..."
  }
}
```

3. Run `npm run daemon:start` — MQTT connects automatically when the config is present

Each light auto-appears in HA as a **Light entity** with on/off, brightness slider,
color temperature, and HSI color — no YAML config required. State stays in sync
regardless of whether you use HA, the CLI, HTTP, or the REPL.

> The always-on **ESP32 bridge** (below) is the recommended way to run this with
> Home Assistant — it doesn't need your Mac running and reflects changes made
> from the desktop/iOS app too. See [`esp32-firmware/`](esp32-firmware/README.md).

## Flashing the ESP32

The ESP32 firmware is a standalone, always-on bridge that joins the mesh and
exposes the lights to Home Assistant (MQTT) and an HTTP API — no Mac needed at
runtime. Full details in [`esp32-firmware/README.md`](esp32-firmware/README.md);
the short version:

```sh
# 1. Install ESP-IDF v5.3.x and source it into your shell.
. ~/esp/esp-idf/export.sh

# 2. Apply the required BLE Mesh core patch (enables inbound state sync).
cd ~/esp/esp-idf
git apply /path/to/amaran-light/esp32-firmware/patches/0001-amaran-net-recv-status-snoop.patch

# 3. Generate the mesh config from the amaran Desktop DB (run from repo root).
cd /path/to/amaran-light
npm install
npm run gen-config

# 4. Fill in Wi-Fi + MQTT credentials.
cd esp32-firmware
cp main/wifi_config.h.example main/wifi_config.h
$EDITOR main/wifi_config.h

# 5. Build and flash (CP210x port shown; Ctrl+] exits the monitor).
idf.py set-target esp32                          # first build only
idf.py -p /dev/cu.SLAB_USBtoUART flash monitor
```

`main/mesh_config.h` and `main/wifi_config.h` are **key-bearing and
`.gitignore`'d — never commit them.**
