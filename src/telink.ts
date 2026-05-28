/*
 * Telink proprietary 0x26 packet builders + status decoder.
 *
 * Ported byte-for-byte from the ESP32 firmware's verified `telink.c`
 * (esp32-firmware/main/telink.c), which is itself cross-checked against the
 * amaran CLI's native_telink_control.swift. This is the single source of
 * truth for the wire format, shared by the mesh controller and the probe
 * tooling.
 *
 * Every builder returns a 10-byte payload: p[0] is a checksum (sum of
 * p[1..9] & 0xff) and p[9] is the command type.
 */

function checksum(p: Buffer): number {
  let s = 0;
  for (let i = 1; i < 10; i++) s += p[i];
  return s & 0xff;
}

function finalize(p: Buffer): Buffer {
  p[0] = checksum(p);
  return p;
}

/** Status-request (cmd_type 0x0e). The fixture replies with its current
 *  state addressed to the provisioner (0x0001); that reply propagates over
 *  the mesh adv channel, which is what makes the desktop/iOS apps and the
 *  ESP32 bridge pick up the change immediately instead of on the next poll. */
export function statusRequest(): Buffer {
  const p = Buffer.alloc(10, 0);
  p[9] = 0x0e;
  return finalize(p);
}

/** On/off (cmd_type 0x8c). */
export function onoff(on: boolean): Buffer {
  const p = Buffer.alloc(10, 0);
  p[8] = on ? 0x01 : 0x00;
  p[9] = 0x8c;
  return finalize(p);
}

/** Brightness (cmd_type 0x8f). intensity 0..1000. */
export function brightness(intensity0to1000: number): Buffer {
  const v = Math.max(0, Math.min(1000, Math.round(intensity0to1000)));
  const p = Buffer.alloc(10, 0);
  p[7] = (v & 3) << 6;
  p[8] = (v >> 2) & 0xff;
  p[9] = 0x8f;
  return finalize(p);
}

/**
 * CCT + green/magenta (cmd_type 0x82). kelvin in K, intensity 0..1000,
 * gmOffset -10..+10 (0 = neutral).
 *
 * The CCT field is kelvin/10 ("telink CCT", 80..2000) packed into bits
 * 52-61 of the low 64. Using raw kelvin overflows that 10-bit field and
 * produces wrong colors — that was the bug in the old TS encoder.
 */
export function cct(kelvin: number, intensity0to1000: number, gmOffset = 0): Buffer {
  const v = Math.max(0, Math.min(1000, Math.round(intensity0to1000)));

  // kelvin -> telink CCT. Match the firmware's C integer division exactly
  // ((kelvin + 5) / 10 truncated) — Math.round would differ on .5 boundaries
  // (e.g. 3000 -> 300, not 301) and shift the packed CCT field by one.
  let tcct = Math.trunc((kelvin + 5) / 10);
  if (tcct < 80) tcct = 80;
  if (tcct > 2000) tcct = 2000;

  let g = Math.round(gmOffset) + 10; // -10..+10 -> 0..20 (neutral 10)
  if (g < 0) g = 0;
  if (g > 20) g = 20;
  const gmFlag = 0; // CLI/firmware always use the green-side field

  let low = (BigInt(v & 3) << 62n);
  let high = 0x8200 | ((v >> 2) & 0xff);
  if (tcct < 1001) {
    low |= BigInt(tcct) << 52n;
    high |= (tcct >> 12) & 0xff;
  } else {
    low |= BigInt((tcct + 0x18) & 0x3ff) << 52n;
    low |= 0x0000040000000000n;
  }
  low |= BigInt(gmFlag & 1) << 43n;
  low |= BigInt(g & 0x7f) << 45n;

  const p = Buffer.alloc(10, 0);
  for (let i = 0; i < 8; i++) p[i] = Number((low >> BigInt(i * 8)) & 0xffn);
  p[8] = high & 0xff;
  p[9] = (high >> 8) & 0xff;
  return finalize(p);
}

/** HSI/color (cmd_type 0x81). hue 0..360, saturation 0..100, intensity 0..1000. */
export function hsi(hueDeg: number, saturation0to100: number, intensity0to1000: number): Buffer {
  const v = Math.max(0, Math.min(1000, Math.round(intensity0to1000)));
  const h = Math.max(0, Math.min(360, Math.round(hueDeg))) & 0x1ff;
  const s = Math.max(0, Math.min(100, Math.round(saturation0to100))) & 0x7f;

  const p = Buffer.alloc(10, 0);
  p[5] = (s & 3) << 6;
  p[6] = ((h & 7) << 5) | ((s >> 2) & 0x1f);
  p[7] = ((h >> 3) & 0x3f) | ((v & 3) << 6);
  p[8] = (v >> 2) & 0xff;
  p[9] = 0x81;
  return finalize(p);
}

export interface TelinkStatus {
  on: boolean;
  isHs: boolean;          // true: HSI/color (0x01); false: CCT (0x02)
  intensity: number;      // 0..1000 (both modes)
  cctKelvin: number;      // CCT mode
  gm: number;             // -10..+10, 0 neutral (CCT mode)
  hue: number;            // 0..360 (HSI mode)
  sat: number;            // 0..100 (HSI mode)
  commandType: number;    // raw p[9] & 0x7f
}

/**
 * Decode a 10-byte Telink status payload (p[0]=checksum .. p[9]=command_type).
 * Returns null for bad checksums or non-state replies (e.g. the 0x0a
 * diagnostic page). The fixture reports its current mode in command_type:
 * 0x02 = CCT, 0x01 = HSI. Power is (low64 >> 8) & 1.
 */
export function decodeStatus(p: Buffer): TelinkStatus | null {
  if (p.length < 10 || p[0] !== checksum(p)) return null;

  const cmd = p[9] & 0x7f;
  let low = 0n;
  for (let i = 0; i < 8; i++) low |= BigInt(p[i]) << BigInt(i * 8);
  const high = p[8] | (p[9] << 8);
  const on = ((low >> 8n) & 1n) === 1n;

  if (cmd === 0x02) {
    const cctRaw = Number((low >> 52n) & 0x3ffn);
    const cctFlag = Number((low >> 42n) & 1n);
    const telinkCct = cctFlag ? cctRaw + 1000 : cctRaw; // kelvin/10
    const intensity = (((high << 2) | Number((low >> 62n) & 3n)) & 0x3ff);
    let gm = Number((low >> 45n) & 0x7fn) - 10;
    if (gm < -10) gm = -10;
    if (gm > 10) gm = 10;
    return { on, isHs: false, intensity, cctKelvin: telinkCct * 10, gm, hue: 0, sat: 0, commandType: cmd };
  }

  if (cmd === 0x01) {
    let sat = ((p[6] & 0x1f) << 2) | ((p[5] >> 6) & 0x03);
    let hue = ((p[7] & 0x3f) << 3) | ((p[6] >> 5) & 0x07);
    let v = (p[8] << 2) | ((p[7] >> 6) & 0x03);
    if (sat > 100) sat = 100;
    if (hue > 360) hue = 360;
    if (v > 1000) v = 1000;
    return { on, isHs: true, intensity: v, cctKelvin: 0, gm: 0, hue, sat, commandType: cmd };
  }

  return null; // 0x0a diagnostic page or unknown
}
