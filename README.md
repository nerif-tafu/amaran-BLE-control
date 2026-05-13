# Amaran Light Controller

Direct Bluetooth Mesh control of Amaran studio lights — **no Amaran Desktop app required**.

## Quick Start

```bash
npm install

# Turn all lights on
npm run mesh:on

# Turn all lights off
npm run mesh:off

# Set brightness (0-100%)
npm run mesh:brightness 75

# Set color temperature
npm run mesh:cct 80 5600
```

## How It Works

Two implementations, both working without the Amaran Desktop app:

### TypeScript (recommended)
`src/mesh-controller.ts` implements the full BLE Mesh stack directly:
- Connects to the Key Light as a Mesh Proxy client
- Sends proxy filter setup (mirrors what the Telink SDK does internally)
- Sends commands using the Telink proprietary opcode `0x26` — reverse-engineered
  from `PyMeshSDK.so` by intercepting `CBPeripheral.writeValue`

### Python (fallback)
`src/pymesh-controller.py` loads `vendor/PyMeshSDK/PyMeshSDK.so` — the actual
Telink SigMeshLib the desktop app ships with — via Python 3.11.

```bash
npm run py:on
npm run py:off
npm run py:brightness 75
npm run py:cct 80 5600
```

## npm Scripts

| Script | Description |
|--------|-------------|
| `mesh:on` | Turn all lights on (TypeScript, direct BLE) |
| `mesh:off` | Turn all lights off (TypeScript, direct BLE) |
| `mesh:brightness` | Set brightness 0-100 |
| `mesh:cct` | Set brightness and colour temp |
| `py:on` | Turn on via Python SDK |
| `py:off` | Turn off via Python SDK |
| `py:brightness` | Set brightness via Python SDK |
| `py:cct` | Set CCT via Python SDK |
| `scan` | Scan for nearby BLE devices |
| `discover <addr>` | Discover services on a device |

## Technical Details

### Mesh Network Config (from `amaran.db`)

Keys extracted from `~/Library/Application Support/amaran Desktop/*/amaran.db`:

| | Value |
|--|--|
| Net Key | `0D8094267D3F4EA5B06B324C8C0AD926` |
| App Key | `AB1C91DC421149FF87694B05A236F214` |
| NID | `0x3B` |
| EncKey | `ce1a0749c640a23be0bdf1c7c95fce93` |
| PrivKey | `96b5a15d3b3d3fa366251132ba16491c` |

### Lights

| Name | MAC | BLE UUID (macOS) | Mesh Addr |
|------|-----|-----------------|-----------|
| Key Light | A4:C1:38:13:41:38 | `B3ED1263-A930-4E51-32B3-EDFBB4C71AEC` | 2 |
| Back Light | A4:C1:38:13:30:86 | `D16927EE-947B-5A0C-ED73-358C29BC4BCD` | 4 |
| Halo 100x | A4:C1:38:56:8C:EF | `F2D070F8-804F-3221-0C60-D56F36767ACC` | 6 |

### The Telink Proprietary Opcode

Standard BLE Mesh models (Generic OnOff, Light Lightness) exist on the lights
and respond to commands — but they are **decoupled from the physical LED output**.
Physical on/off (sleep/wake) is controlled by Telink's proprietary opcode `0x26`
with a 10-byte payload:

```
[checksum, 0, 0, 0, 0, 0, 0, 0, cmd_value, cmd_type]
  checksum = sum(bytes 1-9) & 0xFF
  cmd_type = 0x8C (sleep/wake) | 0x8F (brightness)
  cmd_value = 0x01 (on) / 0x00 (off) for sleep/wake
            = (intensity >> 2) & 0xFF for brightness (intensity 0-1000)
```

Discovered by swizzling `CBPeripheral.writeValue:forCharacteristic:type:` while
running the Python SDK and decrypting the captured BLE Mesh PDU.

### Sequence Numbers

Commands start at a random seq in the 12M–16M range (set with `MESH_SEQ` env var
to override) to avoid replay cache collisions with previous runs.

## Files

```
src/
  mesh-controller.ts     Full TypeScript BLE Mesh implementation (primary)
  pymesh-controller.py   Python SDK wrapper (fallback)
  ble-scanner.ts         BLE device scanner/discovery
  ble-controller.ts      Simple BLE controller (template)
vendor/
  PyMeshSDK/
    PyMeshSDK.so         Telink SigMeshLib Python extension (from app bundle)
```

See `DIRECT-BLE-CONTROL.md` for the full reverse-engineering research notes.

## Requirements

- Node.js 18+ with `@abandonware/noble` (handles BLE on macOS)
- Python 3.11 for the `py:*` scripts: `brew install python@3.11`
- Amaran Desktop app **closed** (it holds the BLE connection)
- Bluetooth permission granted to Terminal/iTerm
