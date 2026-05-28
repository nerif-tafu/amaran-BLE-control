#!/usr/bin/env python3
"""Minimal dependency-free MQTT 3.1.1 subscriber. Connects to the HA broker,
subscribes to the amaran state topics, and prints messages (incl. retained)
for a fixed duration. Used to confirm the ESP32 publishes fixture state.

Usage: mqtt_watch.py [seconds]
"""
import socket
import struct
import sys
import time

HOST, PORT = "192.168.1.146", 1883
USER, PASSWORD = "mqtt-user", "snickers"
TOPIC = "amaran/#"


def enc_len(n):
    out = b""
    while True:
        d = n % 128
        n //= 128
        out += bytes([d | (0x80 if n else 0)])
        if not n:
            return out


def enc_str(s):
    b = s.encode()
    return struct.pack("!H", len(b)) + b


def main():
    secs = float(sys.argv[1]) if len(sys.argv) > 1 else 12.0
    s = socket.create_connection((HOST, PORT), timeout=5)

    # CONNECT with username/password (connect flags 0xC2 = user+pass+clean).
    payload = enc_str("amaran-watch") + enc_str(USER) + enc_str(PASSWORD)
    var = enc_str("MQTT") + bytes([4, 0xC2]) + struct.pack("!H", 30)
    s.sendall(bytes([0x10]) + enc_len(len(var + payload)) + var + payload)
    s.recv(4)  # CONNACK

    # SUBSCRIBE (packet id 1, qos 0).
    body = struct.pack("!H", 1) + enc_str(TOPIC) + bytes([0])
    s.sendall(bytes([0x82]) + enc_len(len(body)) + body)
    s.recv(5)  # SUBACK

    s.settimeout(0.5)
    end = time.time() + secs
    buf = b""
    while time.time() < end:
        try:
            data = s.recv(4096)
            if not data:
                break
            buf += data
        except socket.timeout:
            continue
        # Parse concatenated PUBLISH packets (qos 0).
        while buf:
            if (buf[0] & 0xF0) != 0x30:
                buf = b""
                break
            mult, val, i = 1, 0, 1
            while True:
                if i >= len(buf):
                    break
                b = buf[i]
                val += (b & 0x7F) * mult
                i += 1
                if not (b & 0x80):
                    break
                mult *= 128
            if i >= len(buf) or len(buf) < i + val:
                break
            pkt = buf[i:i + val]
            buf = buf[i + val:]
            tlen = struct.unpack("!H", pkt[:2])[0]
            topic = pkt[2:2 + tlen].decode("utf-8", "replace")
            msg = pkt[2 + tlen:].decode("utf-8", "replace")
            print(f"{topic}  {msg}")
    s.close()


if __name__ == "__main__":
    main()
