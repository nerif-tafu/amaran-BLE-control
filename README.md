# Amaran Light Controller

Direct Bluetooth Mesh control of Amaran studio lights — **no Amaran Desktop app required**.

## Quick Start

```bash
npm install

npm run mesh:on
npm run mesh:off
npm run mesh:brightness 75        # 75%
npm run mesh:cct 80 5600          # 80%, 5600K
npm run mesh:cct 80 5600 15       # 80%, 5600K, GM +15 (green)
npm run mesh:hsi 80 45 60         # 80% brightness, 45° hue, 60% saturation
```

## npm Scripts

| Script | Args | Description |
|--------|------|-------------|
| `mesh:on` | | Turn all lights on |
| `mesh:off` | | Turn all lights off |
| `mesh:brightness` | `<0-100>` | Set brightness % |
| `mesh:cct` | `<brightness> <kelvin> [gm]` | CCT — brightness 0-100, kelvin 2500-7500, optional GM -50 to +50 |
| `mesh:hsi` | `<brightness> <hue> <saturation>` | HSI color — brightness 0-100, hue 0-360°, saturation 0-100 |
| `py:on` | | Turn on via Python SDK fallback |
| `py:off` | | Turn off via Python SDK fallback |
| `py:brightness` | `<0-100>` | Brightness via Python SDK |
| `py:cct` | `<brightness> <kelvin>` | CCT via Python SDK |
| `scan` | | Scan for nearby BLE devices |
| `discover` | `<addr>` | List services on a device |

Individual lights can be targeted by appending `key`, `back`, or `halo`:
```bash
npx tsx src/mesh-controller.ts brightness 50 key
```

## How It Works

`src/mesh-controller.ts` implements a full BLE Mesh stack and connects to the
Key Light as a Mesh Proxy client. All physical controls use **Telink proprietary
opcode `0x26`** — reverse-engineered from `vendor/PyMeshSDK/PyMeshSDK.so` by
intercepting `CBPeripheral.writeValue` while the SDK ran, then decrypting the
captured BLE Mesh PDU.

Standard BLE Mesh models (Generic OnOff, Light Lightness, CTL) ARE present and
respond, but they are decoupled from the physical LED output on these lights.

`src/pymesh-controller.py` is a Python fallback that loads the actual
Telink SigMeshLib from `vendor/PyMeshSDK/PyMeshSDK.so`.

## Mesh Network Config (from `amaran.db`)

Keys extracted from `~/Library/Application Support/amaran Desktop/*/amaran.db`:

| | Value |
|--|--|
| Net Key | `0D8094267D3F4EA5B06B324C8C0AD926` |
| App Key | `AB1C91DC421149FF87694B05A236F214` |
| NID | `0x3B` |
| EncKey | `ce1a0749c640a23be0bdf1c7c95fce93` |
| PrivKey | `96b5a15d3b3d3fa366251132ba16491c` |

## Lights

| Name | MAC | BLE UUID (macOS) | Mesh Addr |
|------|-----|-----------------|-----------|
| Key Light | A4:C1:38:13:41:38 | `B3ED1263-A930-4E51-32B3-EDFBB4C71AEC` | 2 |
| Back Light | A4:C1:38:13:30:86 | `D16927EE-947B-5A0C-ED73-358C29BC4BCD` | 4 |
| Halo 100x | A4:C1:38:56:8C:EF | `F2D070F8-804F-3221-0C60-D56F36767ACC` | 6 |

## Command Payload Format (opcode `0x26`)

All commands share a 10-byte payload: `[checksum, ...packed_bits..., cmd_value, cmd_type]`

| Mode | cmd_type | Encoding |
|------|----------|----------|
| On/Off | `0x8C` | byte[8] = 0x01 on / 0x00 off |
| Brightness | `0x8F` | intensity (0-1000): byte[7] = low2 bits × 64, byte[8] = upper 8 bits |
| CCT | `0x82` | kelvin → `(k+24)&0x3FF` packed at bits 52-61; GM at bits 43-51; intensity same as brightness |
| HSI | `0x81` | hue (9 bits) at bits 53-61; saturation (7 bits) at bits 46-52; intensity as above |

See `DIRECT-BLE-CONTROL.md` for the full reverse-engineering research notes.

## Requirements

- Node.js 18+ (`npm install`)
- Python 3.11 for `py:*` scripts: `brew install python@3.11`
- Amaran Desktop app **closed** (it holds the BLE connection)
- Bluetooth permission granted to Terminal/iTerm
