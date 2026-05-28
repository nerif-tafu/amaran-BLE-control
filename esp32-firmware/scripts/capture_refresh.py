#!/usr/bin/env python3
"""Open the ESP32 serial port, trigger a refresh, and capture mesh logs.

Used to diagnose inbound Telink 0x26 status replies: with the BLE Mesh
stack trace at INFO, bt_mesh_model_recv() logs every decrypted PDU
(src/dst/opcode/payload), so we can see whether the fixtures' status
replies actually reach this node's access layer.
"""
import sys
import time

import serial

PORT = "/dev/cu.SLAB_USBtoUART"
BAUD = 115200


def main():
    capture_secs = float(sys.argv[1]) if len(sys.argv) > 1 else 15.0
    ser = serial.Serial(PORT, BAUD, timeout=0.2)
    time.sleep(0.5)
    ser.reset_input_buffer()

    # Nudge the REPL, then ask for a status refresh of all fixtures.
    ser.write(b"\r\n")
    time.sleep(0.3)
    ser.write(b"refresh\r\n")
    ser.flush()

    deadline = time.time() + capture_secs
    while time.time() < deadline:
        data = ser.read(4096)
        if data:
            sys.stdout.write(data.decode("utf-8", "replace"))
            sys.stdout.flush()
    ser.close()


if __name__ == "__main__":
    main()
