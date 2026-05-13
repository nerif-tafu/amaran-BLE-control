# Amaran Light Direct BLE Control — Research Findings

> **Status: WORKING** — No desktop app required.  
> Primary solution: `src/mesh-controller.ts` (pure TypeScript)  
> Fallback: `src/pymesh-controller.py` (Python SDK wrapper)

---

## Quick Start

```bash
# Quit the Amaran Desktop app first, then:
/opt/homebrew/bin/python3.11 src/pymesh-controller.py on
/opt/homebrew/bin/python3.11 src/pymesh-controller.py off
/opt/homebrew/bin/python3.11 src/pymesh-controller.py brightness 75
/opt/homebrew/bin/python3.11 src/pymesh-controller.py cct 80 5600
```

Or via npm scripts: `npm run py:on`, `npm run py:off`

---

## Background

The Amaran Desktop app connects to three studio lights over BLE Mesh and exposes a WebSocket API. The app needed restarting frequently. The goal was to control the lights directly from scripts without any desktop app dependency.

---

## Approach 1: Standard BLE Mesh Proxy (Did Not Work)

The lights advertise a standard BLE Mesh Proxy service (`0x1828`) with the usual characteristics:
- `0x2ADD` — Proxy Data In (write)
- `0x2ADE` — Proxy Data Out (notify)

### What was tried

The APK (`amaran_1.0.70_APKPure.xapk`) was decompiled with `jadx`, revealing a full Telink SigMeshLib implementation. All cryptographic keys were extracted from `~/Library/Application Support/amaran Desktop/*/amaran.db`.

**Keys extracted:**

| Key | Value |
|-----|-------|
| Net Key | `0D8094267D3F4EA5B06B324C8C0AD926` |
| App Key | `AB1C91DC421149FF87694B05A236F214` |

**Derived values (verified independently in Python and TypeScript):**

| Derived | Value |
|---------|-------|
| NID | `0x3B` |
| EncKey | `ce1a0749c640a23be0bdf1c7c95fce93` |
| PrivKey | `96b5a15d3b3d3fa366251132ba16491c` |
| AID | `0x03` |
| IV Index | `0x00000000` (from Secure Network Beacon) |
| Provisioner SRC | `0x0001` |

**All cryptography was verified correct:**
- `k3(NetKey)` = `0df357c791f677c7` matched the Network ID in the Secure Network Beacon ✓
- Beacon auth value recomputed and matched ✓  
- AES-CCM output matched Python's `cryptography` library ✓
- Full self-decryption of sent packets confirmed correct plaintext ✓

**Packets sent** via noble (`@abandonware/noble`): 23-byte BLE Mesh proxy PDUs with correct structure, targeting unicast addresses 2, 4, 6 and group address `0xC000`.

### Why it failed

Despite correct encryption and ATT-layer acceptance of every write, the lights silently discarded all packets. Extensive debugging ruled out:
- Wrong NID (verified via k3)
- Wrong IV index (verified via beacon auth)
- Wrong source address (tried 20+ addresses, 0x0001–0x7FFF)
- Wrong destination (tried unicast 2/4/6, group 0xC000, broadcast 0xFFFF)
- Wrong opcode encoding
- MTU issues
- Proxy filter state

**Root cause: unknown.** The standard BLE Mesh proxy path simply does not process commands in the way we send them — possibly requiring a specific initialization sequence that the SDK handles internally.

---

## Approach 2: PyMeshSDK (Works)

The Amaran Desktop app bundles the actual Telink SigMeshLib as a compiled Python extension at:

```
/Applications/amaran Desktop.app/Contents/MacOS/PyMeshSDK/PyMeshSDK.so
```

This is the same library the app uses internally, wrapped with pybind11 for Python. Loaded with Homebrew Python 3.11, it provides direct access to the mesh stack.

### Five Bugs That Had to Be Fixed

#### Bug 1: Node names must be MAC addresses

`ConnectTools.isValidNode:` — the internal function that decides whether a discovered BLE peripheral is a known node — does this comparison:

```objc
BOOL match = [[node.name substringFromIndex:6].uppercaseString 
               isEqualToString:peripheral.nodeName.uppercaseString];
```

`peripheral.nodeName` is the **last 6 hex characters** of the MAC address extracted from BLE manufacturer data (e.g., `"134138"` from `A4:C1:38:13:41:38`).

For the comparison to succeed, `node.name` must be a 12-character string whose last 6 characters match — i.e., the MAC address itself (`"A4C138134138"`).

Setting `node.name = "Key Light"` → `"ight"` → never matches → `connectNodeList` stays empty → connection loop runs forever.

**Fix:** `n.name = mac  # e.g. 'A4C138134138'`

#### Bug 2: Set callbacks AFTER `init()`

`MeshSDK::setProxyConnectedCallback` checks whether the internal `MacPlatform*` pointer is non-null before storing the callback. This pointer is `NULL` before `init()` is called. Setting the callback before `init()` silently discards it; the stored `std::function` remains empty.

Later, when `successAction` fires and calls `MacPlatform::proxyConnectedCallback`, an empty `std::function` throws `std::bad_function_call` → SIGABRT.

**Fix:** Call `ms.init(info, callback)` first, then `ms.set_proxy_connected_callback(on_connect)`.

#### Bug 3: CFRunLoopRunInMode required

The `CBCentralManager` inside PyMeshSDK is initialized with `queue: nil`, meaning its delegate callbacks are dispatched to the **main thread's RunLoop**. Without an active RunLoop, `didConnectPeripheral` and `didDiscoverCharacteristicsForService` callbacks never fire, and the connection hangs indefinitely.

**Fix:** Run `CFRunLoopRunInMode(kCFRunLoopDefaultMode, 0.05, False)` in a tight loop on the main thread via ctypes.

#### Bug 4: Double-invocation crash at `successAction`

The connection completes in two stages:
1. The BLE GATT connection is established → `SigBluetooth.proxyConnectedCallBack:` fires → Python `on_connect` is called (works ✓)
2. `successAction` fires → calls `startMeshConnectSuccess` → invokes the completion block stored in `ConnectTools.startMeshConnectCallback` → calls `MacPlatform::proxyConnectedCallback` again

The second call crashes because pybind11's `std::function` wrapper has move-semantic behaviour — the Python callable becomes invalid after the first invocation, leaving the wrapper in an empty state for the second call.

**Fix:** Inside `on_connect`, immediately null out `ConnectTools.startMeshConnectCallback` via the ObjC runtime to prevent the second invocation:

```python
def on_connect(addr):
    result_q.put(('connected', addr))
    ct = msg0(cls('ConnectTools'), 'share')
    if ct:
        msg1(ct, 'setStartMeshConnectCallback:', 0)  # nil
```

#### Bug 5: GIL conflict with multiprocessing

Running PyMeshSDK in the same Python process as other code causes GIL conflicts when the ObjC background threads try to call back into Python. Using `multiprocessing.Process` with `set_start_method('spawn')` gives the SDK a fresh Python interpreter with its own GIL.

**Fix:** Run the SDK in a child process; communicate results via `multiprocessing.Queue`.

---

## SDK API Reference

The key `MeshSDK` methods (Python bindings):

```python
ms = sdk.MeshSDK()
ms.setLogLevel(sdk.LogLevel.Error)
ms.setDumpPath('/tmp')
ms.init(info, callback)                          # Must call first
ms.set_proxy_connected_callback(fn)              # Set AFTER init
ms.set_proxy_disconnected_callback(fn)
ms.reConnectMeshNetwork(['MAC1', 'MAC2', ...])   # Start connecting
ms.sendOnOffCommand(address, isOn)               # 0xFFFF = all lights
ms.sendBrightnessCommand(address, intensity)     # 0–1000
ms.sendCCTCommand(address, cct, intensity, gm, gm_flag)
ms.sendHSICommand(address, hue, saturation, intensity)
ms.disconnectNetwork()
```

`SigMeshInfo` must be populated with nodes whose `name` field is the 12-char MAC address and whose `elements` field contains at least one `SigElementModel` with models defined.

---

## Network Configuration

From `~/Library/Application Support/amaran Desktop/*/amaran.db`:

### Lights

| Name | MAC | BLE UUID (macOS) | Mesh Addr | Device Key |
|------|-----|-----------------|-----------|------------|
| Key Light | A4:C1:38:13:41:38 | `B3ED1263-A930-4E51-32B3-EDFBB4C71AEC` | 2 | `6D008C1F2151BB07F5FA4537E72BC7AF` |
| Back Light | A4:C1:38:13:30:86 | `D16927EE-947B-5A0C-ED73-358C29BC4BCD` | 4 | `71B845D40FC4A1F465A403E7215B07BE` |
| Halo 100x | A4:C1:38:56:8C:EF | `F2D070F8-804F-3221-0C60-D56F36767ACC` | 6 | `C86453CCA0AE408067FE6F31222F907D` |

### Group Addresses

| Name | Address |
|------|---------|
| All lights | `0xC000` |
| All nodes (broadcast) | `0xFFFF` |

---

## File Structure

```
src/
  mesh-controller.ts     ← Primary solution (pure TypeScript, no Python required)
  pymesh-controller.py   ← Fallback solution (Python + PyMeshSDK.so)
vendor/
  PyMeshSDK/PyMeshSDK.so ← Telink SigMeshLib Python extension (copied from app)
```

### Telink Proprietary Opcode (discovered May 2026)

After completing the full BLE Mesh crypto stack in TypeScript and confirming
all standard models (Generic OnOff, Light Lightness) respond correctly,
it was discovered that physical LED output is controlled by a **Telink
proprietary opcode `0x26`** — not any standard BLE Mesh model.

Discovered by: swizzling `CBPeripheral.writeValue:forCharacteristic:type:`
while running the Python SDK, then decrypting the intercepted packet.

Payload format: `[checksum, 0×7, cmd_value, cmd_type]`
- Wake (on): `[0x8D, 0, 0, 0, 0, 0, 0, 0, 0x01, 0x8C]`
- Sleep (off): `[0x8C, 0, 0, 0, 0, 0, 0, 0, 0x00, 0x8C]`

---

## Running Requirements

### TypeScript (mesh-controller.ts)
- Node.js 18+ with `npm install`
- Amaran Desktop app **not running** (would hold the BLE connection)
- macOS with Bluetooth permission granted to Terminal/iTerm

### Python (pymesh-controller.py)
- Homebrew Python 3.11: `/opt/homebrew/bin/python3.11`
- `vendor/PyMeshSDK/PyMeshSDK.so` (copied from the app bundle)
- Amaran Desktop app **not running**

The script automatically deletes `~/Documents/TelinkSDKMeshJsonData` before each run to force fresh initialization from the hard-coded mesh configuration.
