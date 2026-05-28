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

cd esp32-firmware

# 2. Generate main/mesh_config.h from the amaran Desktop DB. Pulls mesh
#    keys, fixtures, and per-fixture capabilities (color / G-M / CCT range)
#    from the app's bundled fixture_config.json.
./scripts/generate_config.py

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

## Two-way sync (known limitation)

State flows **HA / curl / UART → lights** perfectly. The reverse —
changes made *from the desktop or iOS app* showing up in Home Assistant —
does **not** work, and is the one open item.

What works:
- The ESP32 publishes optimistic state to MQTT on every command, so HA's
  own UI always reflects what HA (or curl/UART) did.
- After any command, and every 12 s on a poll, the ESP32 sends a Telink
  status-request (`cmd_type=0x0e`). Fixtures reply, and those replies
  propagate through the mesh — which is what makes the **desktop app**
  re-sync live and lets the **iOS app** show correct state on
  pull-to-refresh.

What doesn't, and why:
- For HA to reflect an external change, the ESP32 must *read* those
  status replies. They come back as a **1-byte `0x26` opcode**. Per the
  BLE Mesh spec, 1-byte opcodes belong to SIG models, so ESP-IDF's mesh
  stack never delivers them to our vendor model's receive callback — the
  bytes hit the radio but are dropped before our code sees them.
  Confirmed empirically: poll requests send fine, zero replies are
  received by the node.
- Cracking it needs raw mesh network-PDU capture + decryption with the
  NetKey (we already have that crypto in `telink.c`/the TS controller),
  bypassing the model layer. That's the next experiment — not yet built.

So today this is a great **control** bridge; it is not yet a **state
feedback** bridge for changes originating outside HA.

## Layout

```
esp32-firmware/
├── CMakeLists.txt
├── sdkconfig.defaults          Bluedroid + BLE Mesh + Wi-Fi + HTTP + MQTT, 4 MB flash
├── partitions.csv              3 MB factory app partition
├── scripts/
│   └── generate_config.py      reads amaran.db + app fixture_config.json → main/mesh_config.h
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

- **New fixture or new mesh keys in Sidus:** re-run
  `./scripts/generate_config.py`, then `idf.py build flash`. If the mesh
  keys themselves changed, `idf.py -p <port> erase-flash` first to clear
  stale NVS provisioning.
- **Unknown fixture code:** capabilities come from the amaran app's
  `fixture_config.json`. Fixtures missing from it (e.g. the Halo / 401C5
  on older app versions) fall back to a small table in
  `generate_config.py` — edit `FALLBACK_CAPS` there if a fixture's
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
