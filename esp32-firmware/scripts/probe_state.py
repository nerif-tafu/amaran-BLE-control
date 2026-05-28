#!/usr/bin/env python3
"""Send a REPL command to the ESP32, then capture the decrypted status
replies (AMARAN-STATUS lines) that follow. The firmware auto-refreshes
~600ms after any setter, so the reply for the new state arrives on its own.

Usage:
    probe_state.py "cct 5600 50 key_light"        # send + capture 6s
    probe_state.py "hsi 0 100 80 key_light" 7
    probe_state.py "" 6                            # capture only (no send)
"""
import re
import sys
import time

import serial

PORT = "/dev/cu.SLAB_USBtoUART"
BAUD = 115200
RX = re.compile(r"AMARAN-STATUS src (0x[0-9a-fA-F]+) dst (0x[0-9a-fA-F]+) len \d+: ([0-9a-fA-F]+)")


def main():
    cmd = sys.argv[1] if len(sys.argv) > 1 else ""
    secs = float(sys.argv[2]) if len(sys.argv) > 2 else 6.0

    ser = serial.Serial(PORT, BAUD, timeout=0.2)
    time.sleep(0.3)
    ser.reset_input_buffer()

    if cmd:
        ser.write(("\r\n" + cmd + "\r\n").encode())
        ser.flush()
        print(f"# sent: {cmd}")

    # Keep every DISTINCT decrypted reply per src, in arrival order, so the
    # 0x02 (CCT) and 0x0a (color) status pages don't clobber each other.
    seen = {}
    buf = ""
    deadline = time.time() + secs
    while time.time() < deadline:
        data = ser.read(4096).decode("utf-8", "replace")
        if not data:
            continue
        buf += data
        for line in buf.split("\n"):
            m = RX.search(line)
            if m:
                src, hexbytes = m.group(1), m.group(3).lower()
                lst = seen.setdefault(src, [])
                if hexbytes not in lst:
                    lst.append(hexbytes)
        buf = buf[-2000:]
    ser.close()

    for src in sorted(seen):
        for hexbytes in seen[src]:
            ct = int(hexbytes[20:22], 16) & 0x7f if len(hexbytes) >= 22 else -1
            print(f"{src}: {hexbytes}   (command_type=0x{ct:02x})")


if __name__ == "__main__":
    main()
