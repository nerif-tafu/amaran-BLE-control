#!/usr/bin/env python3
"""
Amaran Light Controller via PyMeshSDK
Directly controls lights without the desktop app.

Usage:
  python3 src/pymesh-controller.py on
  python3 src/pymesh-controller.py off
  python3 src/pymesh-controller.py brightness <0-100>
  python3 src/pymesh-controller.py cct <brightness 0-100> <kelvin 2500-7500>

Must be run with Python 3.11:
  /opt/homebrew/bin/python3.11 src/pymesh-controller.py on

The SDK is bundled in vendor/PyMeshSDK/ — no app install required.
Install Python 3.11 if needed: brew install python@3.11
"""

import sys
import os
import time
import multiprocessing
import ctypes
import ctypes.util

# Resolve SDK path: prefer bundled vendor copy, fall back to app install
_SCRIPT_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_VENDOR_SDK = os.path.join(_SCRIPT_DIR, "vendor")
_APP_SDK = "/Applications/amaran Desktop.app/Contents/MacOS"
SDK_PATH = _VENDOR_SDK if os.path.exists(os.path.join(_VENDOR_SDK, "PyMeshSDK", "PyMeshSDK.so")) else _APP_SDK
MESH_DATA_FILE = os.path.expanduser("~/Documents/TelinkSDKMeshJsonData")


def mesh_worker(command_args, result_q):
    """Child process: connects to lights via PyMeshSDK and sends commands."""
    # Redirect C-level stdout/stderr to suppress SDK log noise
    devnull = os.open(os.devnull, os.O_WRONLY)
    os.dup2(devnull, 1)
    os.dup2(devnull, 2)
    os.close(devnull)

    sys.path.insert(0, SDK_PATH)
    import PyMeshSDK.PyMeshSDK as sdk

    # Setup CoreFoundation RunLoop for CBCentralManager callbacks
    cf = ctypes.CDLL('/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation')
    cf.CFRunLoopRunInMode.restype = ctypes.c_int
    cf.CFRunLoopRunInMode.argtypes = [ctypes.c_void_p, ctypes.c_double, ctypes.c_bool]
    mode = ctypes.c_void_p.in_dll(cf, 'kCFRunLoopDefaultMode').value
    def rl(s=0.05): return cf.CFRunLoopRunInMode(mode, s, False)

    # ObjC runtime helpers
    libobjc = ctypes.CDLL(ctypes.util.find_library('objc'))
    def sel(s): libobjc.sel_registerName.restype=ctypes.c_void_p; return libobjc.sel_registerName(s.encode())
    def cls(n): libobjc.objc_getClass.restype=ctypes.c_void_p; return libobjc.objc_getClass(n.encode())
    def msg0(obj, s): libobjc.objc_msgSend.restype=ctypes.c_void_p; return libobjc.objc_msgSend(ctypes.c_void_p(int(obj)), ctypes.c_void_p(sel(s))) if obj else 0
    def msg1(obj, s, arg): libobjc.objc_msgSend.restype=ctypes.c_void_p; return libobjc.objc_msgSend(ctypes.c_void_p(int(obj)), ctypes.c_void_p(sel(s)), ctypes.c_void_p(int(arg) if arg else 0)) if obj else 0

    Vec = lambda t: sdk.__dict__['std::vector' + t]

    def make_node(mac, devkey, uuid, addr):
        # Node name MUST be the 12-char MAC address.
        # ConnectTools.isValidNode: compares name.substringFromIndex(6)
        # with the 6-char suffix from BLE advertisement manufacturer data.
        n = sdk.SigNodeModel()
        n.name = mac  # MAC as name for isValidNode: matching
        n.deviceKey = devkey
        n.deviceUUID = uuid
        n.macAddress = mac
        n.meshAddress = addr
        n.defaultTTL = 10
        n.security = 'secure'
        el = sdk.SigElementModel(); el.name = 'E0'; el.index = 0; el.location = '0000'
        m1 = sdk.SigModelIDModel(); m1.modelId = '0000'; m1.bind = Vec('Int')(); m1.subscribe = Vec('String')()
        m2 = sdk.SigModelIDModel(); m2.modelId = '1000'; m2b = Vec('Int')(); m2b.append(0); m2.bind = m2b; m2.subscribe = Vec('String')()
        mls = Vec('SigModelIDModel')(); mls.append(m1); mls.append(m2); el.models = mls
        els = Vec('SigElementModel')(); els.append(el); n.elements = els
        f = sdk.SigNodeFeatures(); f.proxy = 1; f.relay = 0; f.friend = 0; f.lowPower = 0; n.features = f
        nk2 = sdk.SigNodeKeyModel(); nk2.key = 0; nk2.phase = 0
        nkvec2 = Vec('SigNodeKeyModel')(); nkvec2.append(nk2); n.netKeys = nkvec2
        ak2 = sdk.SigNodeKeyModel(); ak2.key = 0; ak2.phase = 0
        akvec2 = Vec('SigNodeKeyModel')(); akvec2.append(ak2); n.appKeys = akvec2
        return n

    # Build mesh config from amaran.db values
    info = sdk.SigMeshInfo()
    info.meshName = 'Amaran'
    info.meshUUID = 'a55390a246e611f0a23eb22370838c37'
    info.ivIndex = 0
    info.sequenceNumber = 9000000

    nk = sdk.SigNetkeyModel(); nk.index = 0; nk.key = '0d8094267d3f4ea5b06b324c8c0ad926'; nk.name = 'NK'
    nkvec = Vec('SigNetkeyModel')(); nkvec.append(nk); info.netKeys = nkvec

    ak = sdk.SigAppkeyModel(); ak.index = 0; ak.key = 'ab1c91dc421149ff87694b05a236f214'; ak.boundNetKey = 0; ak.name = 'AK'
    akvec = Vec('SigAppkeyModel')(); akvec.append(ak); info.appKeys = akvec

    nodesvec = Vec('SigNodeModel')()
    nodesvec.append(make_node('A4C138134138', '6d008c1f2151bb07f5fa4537e72bc7af', '3430304a352d31333431333830306670', 2))  # Key Light
    nodesvec.append(make_node('A4C138133086', '71b845d40fc4a1f465a403e7215b07be', '3430304a352d31333330383630306670', 4))  # Back Light
    nodesvec.append(make_node('A4C138568CEF', 'c86453cca0ae408067fe6f31222f907d', '34303143352d35363843454630306670', 6))  # Halo
    info.nodes = nodesvec

    prov = sdk.SigProvisionerModel()
    prov.provisionerName = 'Prov'
    prov.UUID = '00000000000000000000000000000001'
    r = sdk.SigRangeModel(); r.lowAddress = 1; r.highAddress = 4095
    rvec = Vec('SigRangeModel')(); rvec.append(r); prov.allocatedUnicastRange = rvec
    info.provisioner = prov

    ms = sdk.MeshSDK()
    ms.setLogLevel(sdk.LogLevel.Error)
    ms.setDumpPath('/tmp')

    # KEY: init FIRST (MacPlatform* is null before init, callbacks would be silently dropped)
    ms.init(info, lambda ok: None)
    for _ in range(80): rl(0.05)  # 4 seconds: BT init with RunLoop

    # KEY: set callback AFTER init (MacPlatform is now initialized)
    def on_connect(addr):
        result_q.put(('connected', addr))
        # KEY: null out startMeshConnectCallback to prevent double-invocation crash
        # (successAction calls it a 2nd time causing std::bad_function_call)
        try:
            ct = msg0(cls('ConnectTools'), 'share')
            if ct:
                msg1(ct, 'setStartMeshConnectCallback:', 0)
        except Exception:
            pass

    ms.set_proxy_connected_callback(on_connect)
    ms.set_proxy_disconnected_callback(lambda a: None)

    ms.reConnectMeshNetwork(['A4C138134138', 'A4C138133086', 'A4C138568CEF'])

    # Wait for connection (max 20s)
    deadline = time.time() + 20
    while time.time() < deadline:
        rl(0.05)
        try:
            result_q.get_nowait()
        except Exception:
            pass

    # Send the requested command
    cmd = command_args[0]
    addr = 0xFFFF  # All lights

    if cmd == 'on':
        r = ms.sendOnOffCommand(addr, True)
        result_q.put(('result', f'ON: {r}'))
    elif cmd == 'off':
        r = ms.sendOnOffCommand(addr, False)
        result_q.put(('result', f'OFF: {r}'))
    elif cmd == 'brightness' and len(command_args) > 1:
        pct = int(command_args[1])
        r = ms.sendBrightnessCommand(addr, pct * 10)  # 0-100 → 0-1000
        result_q.put(('result', f'Brightness {pct}%: {r}'))
    elif cmd == 'cct' and len(command_args) > 2:
        brightness = int(command_args[1])
        kelvin = int(command_args[2])
        r = ms.sendCCTCommand(addr, kelvin, brightness * 10, 0, 0)
        result_q.put(('result', f'CCT {brightness}% {kelvin}K: {r}'))

    for _ in range(60): rl(0.05)  # 3s for command to process
    ms.disconnectNetwork()
    result_q.put(('done', None))


def main():
    args = sys.argv[1:]
    if not args:
        print("Usage: python3 src/pymesh-controller.py on|off|brightness <n>|cct <b> <k>")
        sys.exit(1)

    # Remove stale SDK state file (forces fresh initialization from our config)
    if os.path.exists(MESH_DATA_FILE):
        os.remove(MESH_DATA_FILE)

    multiprocessing.set_start_method('spawn')
    q = multiprocessing.Queue()
    p = multiprocessing.Process(target=mesh_worker, args=(args, q))
    p.start()

    command_sent = False
    deadline = time.time() + 45
    while time.time() < deadline:
        try:
            msg = q.get(timeout=1)
            if msg[0] == 'connected':
                print(f'Connected: {msg[1]}')
            elif msg[0] == 'result':
                print(f'Command: {msg[1]}')
                command_sent = True
            elif msg[0] == 'done':
                break
        except Exception:
            if not p.is_alive():
                # Worker crashed during cleanup — only warn if command never sent
                if not command_sent:
                    print(f'Error: worker exited before sending command (code {p.exitcode})')
                    sys.exit(1)
                break

    p.join(timeout=5)
    p.terminate()


if __name__ == '__main__':
    main()
