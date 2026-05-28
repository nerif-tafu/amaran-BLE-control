#!/usr/bin/env python3
"""
Read the amaran Desktop app's SQLite database and emit a C header with the
mesh credentials and fixture list that the ESP32 firmware needs at compile
time.

Default DB path:
    ~/Library/Application Support/amaran Desktop/*/amaran.db

Default output:
    main/mesh_config.h (relative to the firmware project root)

The generated header is key-bearing. It is in .gitignore — do not commit it.
"""

import argparse
import glob
import json
import os
import sqlite3
import sys
import textwrap
from pathlib import Path


DEFAULT_DB_GLOB = os.path.expanduser(
    "~/Library/Application Support/amaran Desktop/*/amaran.db"
)

# Per-fixture capabilities are read from the amaran Desktop app's own
# capability table at Contents/Resources/config/fixture_config.json, keyed
# by `fixture_<code>_<hwver>`. Relevant fields:
#   hsi_support / rgb_support -> has color (HS wheel useful in HA)
#   gm_support                -> accepts green/magenta tint
#   product_cct_min/max       -> CCT range in units of 100 K (25 = 2500K)
#
# Some newer fixtures (e.g. the Halo 100x / 401C5) aren't in older app
# configs. Those fall back to FALLBACK_CAPS, then DEFAULT_CAPS. The Halo
# entry below is from observed hardware (no color, no G/M).
FIXTURE_CONFIG_GLOB = (
    "/Applications/*maran*.app/Contents/Resources/config/fixture_config.json"
)
FALLBACK_CAPS = {
    "401C5": {"color": False, "gm": False, "cct_min": 2500, "cct_max": 7500},
}
DEFAULT_CAPS = {"color": False, "gm": True, "cct_min": 2700, "cct_max": 6500}


def load_fixture_config(explicit=None):
    paths = [explicit] if explicit else []
    paths += sorted(glob.glob(FIXTURE_CONFIG_GLOB), key=os.path.getmtime,
                    reverse=True)
    for p in paths:
        if p and os.path.isfile(p):
            try:
                with open(p) as f:
                    return json.load(f), p
            except (ValueError, OSError):
                continue
    return None, None


def caps_from_config(cfg, code, hwver):
    """Look up a fixture's capabilities in the app config, or None."""
    if not cfg or not code:
        return None
    exact = f"fixture_{code}_{hwver}" if hwver else None
    if exact and exact in cfg:
        key = exact
    else:
        cand = [k for k in cfg if str(k).startswith(f"fixture_{code}_")]
        if not cand:
            return None
        key = sorted(cand)[0]
    e = cfg[key]

    def s(k, d="0"):
        return str(e.get(k, d))

    color = s("hsi_support") == "1" or s("rgb_support") == "1"
    gm = s("gm_support") == "1"
    try:
        cct_min = int(float(s("product_cct_min", "0"))) * 100
        cct_max = int(float(s("product_cct_max", "0"))) * 100
    except ValueError:
        cct_min = cct_max = 0
    if cct_min <= 0 or cct_max <= 0 or cct_min >= cct_max:
        cct_min, cct_max = 2700, 6500
    return {"color": color, "gm": gm, "cct_min": cct_min, "cct_max": cct_max,
            "src": key}


def find_db(explicit_path: str | None) -> str:
    if explicit_path:
        if not os.path.isfile(explicit_path):
            sys.exit(f"DB not found: {explicit_path}")
        return explicit_path
    matches = sorted(glob.glob(DEFAULT_DB_GLOB))
    if not matches:
        sys.exit(
            "Could not locate amaran.db. Pass --db /path/to/amaran.db.\n"
            f"Tried: {DEFAULT_DB_GLOB}"
        )
    # Most recently modified wins.
    matches.sort(key=os.path.getmtime, reverse=True)
    return matches[0]


def extract(db_path: str, fixture_config: str | None = None) -> dict:
    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute("SELECT net_key, app_key FROM mesh LIMIT 1").fetchone()
        if row is None:
            sys.exit("mesh table is empty")
        net_key = row["net_key"].strip().lower()
        app_key = row["app_key"].strip().lower()

        # iv_index column is optional — the Desktop DB may store it in a
        # different shape across versions. Fall back to 0 and let the firmware
        # recover the real value from the Secure Network Beacon at runtime.
        iv_index = 0
        try:
            iv_row = conn.execute("SELECT iv_index FROM mesh LIMIT 1").fetchone()
            if iv_row is not None and iv_row["iv_index"] is not None:
                iv_index = int(iv_row["iv_index"])
        except sqlite3.OperationalError:
            pass

        fixtures = conn.execute(
            "SELECT mac_address, node_address, name, code, control_hw_version "
            "FROM fixtures WHERE node_address > 1 "
            "ORDER BY node_address"
        ).fetchall()
    finally:
        conn.close()

    cfg, cfg_path = load_fixture_config(fixture_config)
    if cfg_path:
        print(f"Capabilities from {os.path.basename(cfg_path)}")

    lights = []
    for f in fixtures:
        mac = (f["mac_address"] or "").strip().upper()
        addr = int(f["node_address"])
        name = (f["name"] or f"Light {addr}").strip()
        code = (f["code"] or "").strip().upper()
        hwver = (f["control_hw_version"] or "").strip()
        if not mac or addr < 2:
            continue

        caps = caps_from_config(cfg, code, hwver)
        if caps is not None:
            source = caps.pop("src")
        elif code in FALLBACK_CAPS:
            caps = FALLBACK_CAPS[code]
            source = "fallback table"
        else:
            caps = DEFAULT_CAPS
            source = "default (code not in config)"
        print(f"  {name}: code={code} hw={hwver or '?'} "
              f"color={caps['color']} gm={caps['gm']} "
              f"cct={caps['cct_min']}-{caps['cct_max']}K [{source}]")

        lights.append({
            "mac": mac, "address": addr, "name": name, "code": code,
            "color": caps["color"], "gm": caps["gm"],
            "cct_min": caps["cct_min"], "cct_max": caps["cct_max"],
        })

    return {
        "net_key": net_key,
        "app_key": app_key,
        "iv_index": iv_index,
        "lights": lights,
    }


def parse_hex_key(label: str, value: str) -> bytes:
    cleaned = value.replace(" ", "").replace(":", "")
    try:
        out = bytes.fromhex(cleaned)
    except ValueError as e:
        sys.exit(f"{label}: not valid hex ({e})")
    if len(out) != 16:
        sys.exit(f"{label}: expected 16 bytes, got {len(out)}")
    return out


def parse_mac(mac: str) -> bytes:
    parts = mac.replace("-", ":").split(":")
    if len(parts) != 6:
        sys.exit(f"Bad MAC: {mac}")
    return bytes(int(p, 16) for p in parts)


def c_byte_array(data: bytes) -> str:
    return ", ".join(f"0x{b:02x}" for b in data)


def c_identifier(name: str) -> str:
    out = []
    for ch in name.lower():
        if ch.isalnum():
            out.append(ch)
        elif out and out[-1] != "_":
            out.append("_")
    s = "".join(out).strip("_")
    return s or "light"


def emit_header(data: dict, db_path: str, relay_hub_mac: str | None) -> str:
    net_key = parse_hex_key("net_key", data["net_key"])
    app_key = parse_hex_key("app_key", data["app_key"])
    iv_index = int(data["iv_index"])
    lights = data["lights"]
    if not lights:
        sys.exit("No lights found in fixtures table")

    # Pick a relay hub: explicit override, otherwise the first light.
    chosen_relay = None
    if relay_hub_mac:
        want = relay_hub_mac.upper().replace("-", ":")
        for l in lights:
            if l["mac"].upper().replace("-", ":") == want:
                chosen_relay = l
                break
        if chosen_relay is None:
            sys.exit(f"Relay hub MAC {relay_hub_mac} not found among lights")
    else:
        chosen_relay = lights[0]

    seen_keys = set()
    keys = []
    for l in lights:
        k = c_identifier(l["name"])
        base = k
        i = 2
        while k in seen_keys:
            k = f"{base}_{i}"
            i += 1
        seen_keys.add(k)
        keys.append(k)

    light_lines = []
    for k, l in zip(keys, lights):
        mac_bytes = parse_mac(l["mac"])
        light_lines.append(
            "    {{ .key = \"{key}\", .name = \"{name}\", "
            ".mac = {{ {mac} }}, .address = 0x{addr:04x}, "
            ".has_color = {color}, .has_gm = {gm}, "
            ".cct_min = {cct_min}, .cct_max = {cct_max} }},".format(
                key=k,
                name=l["name"].replace('"', '\\"'),
                mac=c_byte_array(mac_bytes),
                addr=l["address"],
                color="true" if l["color"] else "false",
                gm="true" if l["gm"] else "false",
                cct_min=l["cct_min"],
                cct_max=l["cct_max"],
            )
        )

    relay_mac_bytes = parse_mac(chosen_relay["mac"])

    # Don't produce the literal */ inside a C block comment — use a redacted
    # placeholder for the path.
    redacted_db = "<amaran Desktop DB: " + os.path.basename(
        os.path.dirname(db_path)
    ) + ">"
    header = textwrap.dedent(
        f"""\
        /*
         * Auto-generated by scripts/generate_config.py — DO NOT EDIT BY HAND.
         * Source: {redacted_db}
         *
         * This file is KEY-BEARING. Do not commit, paste, or share.
         */

        #ifndef AMARAN_MESH_CONFIG_H
        #define AMARAN_MESH_CONFIG_H

        #include <stdint.h>
        #include <stddef.h>
        #include <stdbool.h>

        #define AMARAN_LIGHT_COUNT {len(lights)}

        typedef struct {{
            const char *key;
            const char *name;
            uint8_t mac[6];        /* big-endian, as printed (XX:XX:XX:XX:XX:XX) */
            uint16_t address;      /* mesh unicast address */
            bool has_color;        /* RGB emitters — expose HS color in HA */
            bool has_gm;           /* accepts green/magenta tint */
            uint16_t cct_min;      /* CCT slider lower bound (Kelvin) */
            uint16_t cct_max;      /* CCT slider upper bound (Kelvin) */
        }} amaran_light_t;

        static const uint8_t AMARAN_NET_KEY[16] = {{ {c_byte_array(net_key)} }};
        static const uint8_t AMARAN_APP_KEY[16] = {{ {c_byte_array(app_key)} }};
        static const uint32_t AMARAN_IV_INDEX_INITIAL = 0x{iv_index:08x};
        static const uint8_t AMARAN_RELAY_HUB_MAC[6] = {{ {c_byte_array(relay_mac_bytes)} }};

        /* Group / control addresses */
        #define AMARAN_GROUP_ALL    0xC000
        #define AMARAN_BROADCAST    0xFFFF
        #define AMARAN_LOCAL_SRC    0x0001

        static const amaran_light_t AMARAN_LIGHTS[AMARAN_LIGHT_COUNT] = {{
        """
    )
    header += "\n".join(light_lines)
    header += "\n};\n\n#endif /* AMARAN_MESH_CONFIG_H */\n"
    return header


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--db",
        default=None,
        help="Path to amaran.db. Defaults to the latest one under "
        "~/Library/Application Support/amaran Desktop/*/amaran.db",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Path to write the C header. Defaults to ../main/mesh_config.h "
        "relative to this script.",
    )
    parser.add_argument(
        "--relay-hub",
        default=None,
        help="Override the relay hub MAC (defaults to the first fixture).",
    )
    parser.add_argument(
        "--fixture-config",
        default=None,
        help="Path to the amaran app's fixture_config.json for capability "
        "detection. Defaults to the app bundle under /Applications.",
    )
    args = parser.parse_args()

    db_path = find_db(args.db)
    data = extract(db_path, args.fixture_config)

    out_path = args.out or str(
        Path(__file__).resolve().parent.parent / "main" / "mesh_config.h"
    )
    out_dir = os.path.dirname(out_path)
    if out_dir and not os.path.isdir(out_dir):
        os.makedirs(out_dir, exist_ok=True)

    text = emit_header(data, db_path, args.relay_hub)

    # Write key-bearing files mode 0600.
    fd = os.open(out_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, text.encode("utf-8"))
    finally:
        os.close(fd)

    print(f"Wrote {out_path} ({len(data['lights'])} fixtures)")


if __name__ == "__main__":
    main()
