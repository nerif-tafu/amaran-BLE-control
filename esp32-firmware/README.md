# amaran ESP32 mesh-control firmware

ESP-IDF firmware that turns an ESP-32S / ESP32 WROOM-32 module into a
permanent BLE Mesh node in your amaran studio mesh. It sends Telink
`0x26` vendor commands for on/off / brightness / CCT / color / green-
magenta, and exposes the fixtures to your LAN two ways:

- **MQTT with Home Assistant discovery** — fixtures auto-appear as HA
  `light` entities (+ a `number` entity for green/magenta).
- **HTTP REST API** — `curl` / scripts / your own UI.

Mesh keys and per-fixture capabilities are read at build time from the
**amaran Desktop** app's local files and self-injected into ESP-IDF's
BLE Mesh stack, so no Sidus provisioning of the ESP32 is required. The
desktop and iPad apps keep working alongside it.

> Status: working on real hardware (ESP-32S, 3× amaran fixtures) as of
> 2026-05-28. One known limitation — external-app → HA state sync — is
> documented under [Two-way sync](#two-way-sync-known-limitation).

## Hardware

- ESP-32S (WROOM-32) module, 4 MB flash, 40 MHz crystal.
- USB-serial connection for flashing (CP210x → `/dev/cu.SLAB_USBtoUART`).
- A Wi-Fi network and an MQTT broker reachable on it (Home Assistant's
  Mosquitto add-on is the easy path).

## One-time setup

```sh
# 1. Install ESP-IDF v5.3.x and source it into your shell.
. ~/esp/esp-idf/export.sh

# 2. Generate esp32-firmware/main/mesh_config.h from the amaran Desktop DB.
#    Pulls mesh keys, fixtures, and per-fixture capabilities (color / G-M /
#    CCT range) from the app's bundled fixture_config.json. Run from the
#    repo root (it's a TypeScript tool in the main project):
npm install
npm run gen-config         # options: -- --db <path> --relay-hub <MAC>

cd esp32-firmware

# 3. Copy the Wi-Fi/MQTT template and fill in your values.
cp main/wifi_config.h.example main/wifi_config.h
$EDITOR main/wifi_config.h
```

`main/wifi_config.h` fields:

| Field | Notes |
|---|---|
| `WIFI_SSID` / `WIFI_PASSWORD` | Your 2.4 GHz network |
| `MQTT_URI` | e.g. `mqtt://192.168.1.10:1883` (the broker's IP is more reliable than mDNS on ESP32) |
| `MQTT_USERNAME` / `MQTT_PASSWORD` | Broker login, or `""` for anonymous |
| `HA_DISCOVERY_PREFIX` | Leave `homeassistant` unless changed in HA |
| `MQTT_TOPIC_PREFIX` | `amaran` → topics like `amaran/key_light/set` |
| `DEVICE_ID` | Change if you run more than one of these nodes |

`main/mesh_config.h` and `main/wifi_config.h` are **key-bearing and
`.gitignore`'d — never commit them.**

## Build, flash, monitor

```sh
idf.py set-target esp32          # first build only
idf.py -p /dev/cu.SLAB_USBtoUART flash monitor   # Ctrl+] to exit
```

Healthy boot log:

```
amaran_node: NODE_PROV_COMPLETE net_idx=0x000 addr=0x0010
amaran_node: self-provisioned: addr=0x0010 net_idx=0x000 app_idx=0x000
amaran_wifi: got ip 192.168.x.x
amaran_mqtt: MQTT connected
amaran_mqtt: discovery published: homeassistant/light/amaran-esp32_key_light/config
amaran_http: http listening on :80
```

Provisioning persists in NVS, so later reboots come straight up ready.
The `AppKey already exists` / `Already bound` warnings on reboot are
expected (NVS already holds the keys) and harmless.

## Home Assistant

With HA's MQTT integration + discovery enabled (default), the fixtures
appear under **Settings → Devices & Services → MQTT** as device
**"amaran ESP32 mesh bridge"**:

- one `light` entity per fixture — on/off, brightness, CCT slider, and a
  color wheel **only on color-capable fixtures**;
- one `number` entity per fixture that supports green/magenta
  (`<name> G/M`, −10 … +10, 0 = neutral, negative greener, positive
  more magenta).

Capabilities are detected per fixture from the amaran app config
(`hsi_support`, `gm_support`, `product_cct_min/max`), so CCT-only
fixtures don't show a dead color wheel or G/M slider.

## HTTP REST API

The ESP32's IP is in the boot log (`amaran_wifi: got ip ...`). A DHCP
reservation on your router keeps it stable.

```sh
curl http://<esp32-ip>/lights                     # list fixtures (JSON)

curl -X POST http://<esp32-ip>/lights/key_light/on
curl -X POST http://<esp32-ip>/lights/key_light/off
curl -X POST http://<esp32-ip>/lights/all/off      # target: key, "all", addr, or 0xNNNN

curl -X POST http://<esp32-ip>/lights/key_light/brightness \
     -H 'content-type: application/json' -d '{"value": 40}'
curl -X POST http://<esp32-ip>/lights/back_light/cct \
     -H 'content-type: application/json' -d '{"kelvin": 4700, "intensity": 30, "gm": 0}'
curl -X POST http://<esp32-ip>/lights/key_light/hsi \
     -H 'content-type: application/json' -d '{"hue": 200, "sat": 80, "intensity": 60}'

curl -X POST http://<esp32-ip>/refresh             # nudge desktop/iPad apps to re-sync
curl -X POST http://<esp32-ip>/lights/key_light/refresh
```

## UART REPL

The serial monitor doubles as a control surface for debugging:

```
> list
> on            > off back_light
> brightness 25 key_light
> cct 4700 30            # cct <kelvin> <0-100%> [target] [gm -10..10]
> hsi 200 80 60          # hsi <hue> <sat> <int%> [target]
> refresh
> status
> help
```

## Two-way sync

State flows **both ways**: HA / curl / UART → lights, *and* changes made
from the **desktop / iOS app or a physical knob** now show up in Home
Assistant.

Outbound (HA → lights):
- The ESP32 publishes state to MQTT on every command, and after any
  command + every 12 s it sends a Telink status-request (`cmd_type=0x0e`).
  Fixtures reply, and those replies propagate through the mesh — which is
  what makes the **desktop app** re-sync live and lets the **iOS app**
  show correct state on pull-to-refresh.

Inbound (lights → HA) — the status snoop:
- The catch is that Telink fixtures route every `0x26` status reply to the
  **provisioner unicast `0x0001`**, never to whoever requested status.
  Our node (`0x0010`) network-decrypts the reply (we have the NetKey) but
  the mesh stack drops it before the access layer: `trans_unseg()` bails on
  any non-local message, and the model dispatch requires the destination to
  be one of our own element addresses. So no amount of model registration
  can catch it. (The earlier "1-byte `0x26` opcode" theory was a red
  herring — the opcode is fine; the *destination address* is the problem.)
- The fix is a small **patch to the ESP-IDF BLE Mesh core** (see
  [`patches/`](patches/)). It adds a passive snoop in `bt_mesh_net_recv`
  that decrypts a *copy* of the access payload with the studio AppKey and
  hands the plaintext to the firmware via the weak hook
  `amaran_mesh_access_rx()` (implemented in `main.c`). The relay path is
  untouched, so desktop/iOS re-sync still works.
- `amaran_telink_decode_status()` (`telink.c`) decodes the reply. The
  fixture reports its **current mode** in `command_type`: `0x02` = CCT
  (kelvin, intensity, G/M), `0x01` = HSI/color (hue, sat, intensity), with
  power in `(low64 >> 8) & 1`. `command_type 0x0a` is a constant diagnostic
  page the desktop polls and is ignored. The CCT layout matches Aaron's
  `decodePacket`; HSI uses the same bit-packing as the HSI setter (both
  confirmed against live replies).
- `amaran_mqtt_report_state()` (`mqtt.c`) updates HA **only when a reading
  differs materially** from what we last commanded, so the echo of our own
  commands doesn't churn HA while genuine external changes propagate.

> **Important:** the inbound path requires the `patches/` patch applied to
> your ESP-IDF checkout. Without it, the firmware still builds and the
> outbound direction works, but HA won't reflect external changes (the weak
> hook is never called).

### Debugging the snoop

TypeScript helpers in the **main project** (`../scripts/`, run from the repo
root) verify the reply format. For the probe, build the firmware with
`CONFIG_BLE_MESH_STACK_TRACE_LEVEL=3` so the patch logs the raw decrypted PDUs:
- `npm run esp32:probe -- "<repl command>"` — send a command, decode the
  resulting status replies per fixture using the shared `src/telink.ts`
  decoder (the same logic the firmware uses — a cross-check that they agree).
- `npm run mqtt:watch` — subscribe to the `amaran/.../state` topics to confirm
  what reached the broker (reads broker/creds from `lights.json`).
- `npm run esp32:capture` — trigger a refresh and dump raw serial.

## Layout

```
esp32-firmware/
├── CMakeLists.txt
├── sdkconfig.defaults          Bluedroid + BLE Mesh + Wi-Fi + HTTP + MQTT, 4 MB flash
├── partitions.csv              3 MB factory app partition
├── patches/                    ESP-IDF core patch for the inbound status snoop (required)
└── main/
    ├── main.c                  app_main, mesh self-provision, dispatch, UART REPL, poll
    ├── mesh_config.h           generated; KEY-BEARING; .gitignore'd
    ├── wifi_config.h.example   credentials template
    ├── wifi_config.h           you create; KEY-BEARING; .gitignore'd
    ├── telink.[ch]             Telink 0x26 packet builders (on/off/bri/CCT+G-M/HSI/status)
    ├── wifi.[ch]               Wi-Fi STA bring-up + reconnect
    ├── mqtt.[ch]               MQTT client, HA discovery, command parsing, debounced state
    └── http.[ch]               HTTP REST API
```

Build/debug tooling lives in the **main TS project** (`scripts/`, run from the
repo root): `gen-config` (writes `main/mesh_config.h`), `esp32:probe`,
`esp32:capture`, and `mqtt:watch`.

## How it works

**Self-provisioning** — ESP-IDF has no public API to import pre-known
mesh keys, so we use internal helpers (`mesh/main.h`, `local.h`):

1. `esp_ble_mesh_node_prov_enable(ADV|GATT)` — sets the `BLE_MESH_NODE` flag.
2. `bt_mesh_provision(net_key, …, addr, dev_key)` — sets `BLE_MESH_VALID`,
   loads NetKey + DeviceKey + unicast address `0x0010`.
3. In `NODE_PROV_COMPLETE_EVT`: `bt_mesh_node_local_app_key_add` then
   `bt_mesh_node_bind_app_key_to_model`.

The DeviceKey is randomized per boot — we never use Config Client traffic.

**Telink opcode** — control/status uses opcode `0x26` as a raw 1-byte
opcode (`0x26 < 0x80`), not the standard 3-byte vendor encoding. We send
it directly via `esp_ble_mesh_server_model_send_msg`; the fixtures'
Telink stack dispatches on the byte. The CCT/G-M/HSI bit-packing is
ported byte-for-byte from the amaran CLI's `native_telink_control.swift`
and cross-checked against it.

## Maintenance

- **New fixture or new mesh keys in Sidus:** re-run `npm run gen-config`
  (from the repo root), then `idf.py build flash`. If the mesh keys
  themselves changed, `idf.py -p <port> erase-flash` first to clear stale
  NVS provisioning.
- **Unknown fixture code:** capabilities come from the amaran app's
  `fixture_config.json`. Fixtures missing from it (e.g. the Halo / 401C5
  on older app versions) fall back to a small table in
  `scripts/generate-config.ts` — edit `FALLBACK_CAPS` there if a fixture's
  color/G-M/CCT is wrong.
- **Wi-Fi + BLE coexistence** is handled by the software-coex layer (on
  by default). A single reconnect retry at boot is normal.

## Relationship to Aaron's amaran CLI

This is an independent ESP32 firmware. It reuses two things from Aaron's
macOS amaran project (a clone of which lives under `../amaran/` here, if
present): the reverse-engineered Telink `0x26` packet formats (see
`native_telink_control.swift`) and the "status-request refreshes the
apps" trick (his TUI's Shift+R). Everything on the ESP32 — mesh node
self-provisioning, Wi-Fi/MQTT/HTTP, HA discovery — is new here. Aaron's
`firmware/sidus-join-probe/` is a different thing entirely: an nRF52840
key-capture probe, not a controller.
