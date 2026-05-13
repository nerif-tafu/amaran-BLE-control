# Amaran Light Controller

Control your Amaran 150c light from the command line or scripts.

## Quick Start

```bash
# Install dependencies
npm install

# Turn light on
npx tsx src/amaran-control.ts on

# Turn light off  
npx tsx src/amaran-control.ts off

# Set brightness to 75%
npx tsx src/amaran-control.ts brightness 75

# Set color temperature to 5600K
npx tsx src/amaran-control.ts cct 5600
```

## How It Works

The Amaran Desktop app exposes a WebSocket server on `ws://127.0.0.1:33782` that accepts JSON-RPC commands. This controller:

1. Automatically starts the Amaran Desktop app if not running
2. Connects to the WebSocket server
3. Sends commands to control the light

## Commands

| Command | Description |
|---------|-------------|
| `on` | Turn light on (wake from sleep) |
| `off` | Turn light off (sleep mode) |
| `toggle` | Toggle on/off |
| `brightness <0-100>` | Set brightness percentage |
| `cct <2500-7500>` | Set color temperature in Kelvin |
| `status` | Show current light status |

## Integration Examples

### Shell Script
```bash
#!/bin/bash
# Toggle light for video calls
cd ~/Sites/amaran-light
npx tsx src/amaran-control.ts toggle
```

### Stream Deck
Create a button that runs:
```bash
cd ~/Sites/amaran-light && npx tsx src/amaran-control.ts toggle
```

### Home Assistant (via shell_command)
```yaml
shell_command:
  amaran_on: "cd ~/Sites/amaran-light && npx tsx src/amaran-control.ts on"
  amaran_off: "cd ~/Sites/amaran-light && npx tsx src/amaran-control.ts off"
```

## Technical Details

### Bluetooth Mesh
The Amaran 150c uses **Bluetooth Mesh** (Telink SDK), not simple BLE. This requires:
- Network provisioning
- Encryption keys (NetKey, AppKey)
- IV Index tracking
- Proper mesh message formatting

The mesh network configuration is stored in:
```
~/Library/Application Support/amaran Desktop/*/amaran.db
```

### Mesh Keys Found
- **Network Key**: `0D8094267D3F4EA5B06B324C8C0AD926`
- **App Key**: `AB1C91DC421149FF87694B05A236F214`
- **Node Address**: `2`

### Standard Mesh Opcodes Used
- Generic OnOff Set: `0x8202`
- Light Lightness Set: `0x824C`
- Light CTL Set: `0x825E`

### Why WebSocket Instead of Direct BLE?
Bluetooth Mesh encryption is complex. The PyMeshSDK in the app handles:
- AES-CCM encryption/decryption
- IV Index management
- Sequence number tracking
- Transport layer segmentation

Reimplementing this would require a full Bluetooth Mesh stack.

## Files

- `src/amaran-control.ts` - Main controller (WebSocket-based)
- `src/mesh-controller.ts` - Experimental direct BLE mesh control
- `src/websocket-controller.ts` - Lower-level WebSocket controller
- `src/ble-scanner.ts` - BLE device scanner/discovery

## Requirements

- Node.js 18+
- Amaran Desktop app installed
- macOS (for BLE support)
