/**
 * Amaran BLE Mesh Controller
 *
 * Directly controls Amaran lights via Bluetooth Mesh, bypassing the desktop app.
 * Protocol reverse-engineered from com.sidus.link.amaran APK v1.0.70.
 *
 * Keys extracted from: ~/Library/Application Support/amaran Desktop/<id>/amaran.db
 *
 * Usage:
 *   npx tsx src/mesh-controller.ts on [light]
 *   npx tsx src/mesh-controller.ts off [light]
 *   npx tsx src/mesh-controller.ts brightness <0-100> [light]
 *   npx tsx src/mesh-controller.ts cct <brightness 0-100> <kelvin 2500-7500> [light]
 *   npx tsx src/mesh-controller.ts hsl <brightness 0-100> <hue 0-360> <saturation 0-100> [light]
 *   light = key | back | halo | all (default: all)
 */

import * as crypto from "crypto";
// @ts-ignore
import noble from "@abandonware/noble";

// ─── Mesh Network Config (from amaran.db) ────────────────────────────────────

const NET_KEY = Buffer.from("0D8094267D3F4EA5B06B324C8C0AD926", "hex");
const APP_KEY = Buffer.from("AB1C91DC421149FF87694B05A236F214", "hex");

const LIGHTS: Record<string, { mac: string; uuid: string; address: number; name: string }> = {
  // mac = real MAC (Linux), uuid = CoreBluetooth UUID (macOS, from ble-scanner output)
  key: { mac: "a4:c1:38:13:41:38", uuid: "b3ed1263a9304e5132b3edfbb4c71aec", address: 2, name: "Key Light" },
  back: { mac: "a4:c1:38:13:30:86", uuid: "f2d070f8804f32210c60d56f36767acc", address: 4, name: "Back Light" },
  halo: { mac: "a4:c1:38:56:8c:ef", uuid: "d16927ee947b5a0ced73358c29bc4bcd", address: 6, name: "Halo 100x" },
};

// Key Light is the reliable relay hub — the desktop app always connects through it.
const RELAY_HUB_UUID = LIGHTS.key.uuid;

// Group "All" address from amaran.db groups table (node_address=49152=0xC000)
const GROUP_ALL = 0xc000;

// Provisioner address (0x0001 is standard for SIG mesh provisioner).
// PyMeshSDK binary had 'DC2C26000001' suggesting last seq for addr 0x0001
// was 0x262CDC = 2,502,844 — we start our seq above that.
const LOCAL_ADDRESS = 0x0001;
const DEFAULT_TTL = 10;

// ─── BLE UUIDs ───────────────────────────────────────────────────────────────

const PROXY_SERVICE = "1828";
const PROXY_DATA_IN = "2add"; // write mesh messages here
const PROXY_DATA_OUT = "2ade"; // notifications come from here

// ─── Mesh Opcodes (stored as little-endian integers — see Opcode.java) ───────

const OP = {
  ONOFF_GET: 0x0182,        // 0x8201 on wire — acknowledged get (light must respond)
  ONOFF_SET: 0x0282,        // 0x8202 on wire — acknowledged set (light must respond)
  ONOFF_SET_NOACK: 0x0382,  // 0x8203 on wire
  LIGHTNESS_SET: 0x4c82,    // 0x824C on wire — acknowledged set
  LIGHTNESS_SET_NOACK: 0x4d82, // 0x824D on wire
  CTL_SET_NOACK: 0x5f82,    // 0x825F on wire
  HSL_SET_NOACK: 0x7782,    // 0x8277 on wire
  // Telink proprietary opcode — reverse-engineered from PyMeshSDK.so sendOnOffCommand.
  // NOT a standard BLE Mesh model. sendOnOffCommand calls sendTelinkDataAppendHeaderWithAddress
  // which uses opcode 0x26 (1-byte SIG slot) with a 10-byte checksum payload.
  // Payload format: [checksum, 0×7, cmd_value, cmd_type]
  //   sleep/wake:  cmd_type=0x8C, cmd_value=0x01(on) or 0x00(off)
  //   brightness:  cmd_type=0x8F, cmd_value=(intensity>>2)&0xFF  (intensity 0–1000)
  TELINK_CMD: 0x26,
};

// ─── Proxy PDU types ─────────────────────────────────────────────────────────

const PROXY_TYPE_NETWORK = 0x00;
const PROXY_TYPE_BEACON = 0x01;
const PROXY_TYPE_PROXY_CONFIG = 0x02;

// ─── Proxy configuration opcodes (BLE Mesh spec §6.5) ────────────────────────

const PROXY_CFG_SET_FILTER_TYPE = 0x00;
const PROXY_CFG_ADD_ADDRESSES   = 0x01;
const PROXY_FILTER_WHITELIST    = 0x00;

// ─── Crypto helpers ──────────────────────────────────────────────────────────

function aesEcbBlock(key: Buffer, data: Buffer): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ecb", key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(data), cipher.final()]);
}

function aesCmac(key: Buffer, message: Buffer): Buffer {
  // Generate K1 and K2 subkeys
  const L = aesEcbBlock(key, Buffer.alloc(16, 0));
  const K1 = cmacShiftLeft(L, L[0] & 0x80 ? 0x87 : 0);
  const K2 = cmacShiftLeft(K1, K1[0] & 0x80 ? 0x87 : 0);

  const n = Math.ceil(message.length / 16) || 1;
  const lastComplete = message.length > 0 && message.length % 16 === 0;

  let x = Buffer.alloc(16, 0);

  for (let i = 0; i < n - 1; i++) {
    const block = message.subarray(i * 16, i * 16 + 16);
    for (let j = 0; j < 16; j++) x[j] ^= block[j];
    x = aesEcbBlock(key, x);
  }

  const lastBlock = Buffer.alloc(16, 0);
  if (lastComplete) {
    message.copy(lastBlock, 0, (n - 1) * 16, n * 16);
    for (let j = 0; j < 16; j++) lastBlock[j] ^= K1[j];
  } else {
    const rem = message.length % 16;
    if (rem > 0) message.copy(lastBlock, 0, (n - 1) * 16, (n - 1) * 16 + rem);
    lastBlock[rem] = 0x80;
    for (let j = 0; j < 16; j++) lastBlock[j] ^= K2[j];
  }

  for (let j = 0; j < 16; j++) x[j] ^= lastBlock[j];
  return aesEcbBlock(key, x);
}

function cmacShiftLeft(b: Buffer, xorByte: number): Buffer {
  const out = Buffer.alloc(16);
  let carry = 0;
  for (let i = 15; i >= 0; i--) {
    out[i] = ((b[i] << 1) | carry) & 0xff;
    carry = (b[i] & 0x80) ? 1 : 0;
  }
  if (xorByte) out[15] ^= xorByte;
  return out;
}

function s1(m: Buffer): Buffer {
  return aesCmac(Buffer.alloc(16, 0), m);
}

// k2: derive NID, EncryptionKey, PrivacyKey from NetKey
// Ref: Bluetooth Mesh spec §3.6.5.1 / Encipher.java k2()
function k2(netKey: Buffer): { nid: number; encKey: Buffer; privKey: Buffer } {
  const salt = s1(Buffer.from("smk2"));
  const T = aesCmac(salt, netKey);
  const P = Buffer.from([0x00]); // master security material

  const T1 = aesCmac(T, Buffer.concat([P, Buffer.from([0x01])]));
  const T2 = aesCmac(T, Buffer.concat([T1, P, Buffer.from([0x02])]));
  const T3 = aesCmac(T, Buffer.concat([T2, P, Buffer.from([0x03])]));

  return { nid: T1[15] & 0x7f, encKey: T2, privKey: T3 };
}

// k4: derive AID from AppKey
// Ref: Bluetooth Mesh spec §3.6.5.4 / Encipher.java k4()
function k4(appKey: Buffer): number {
  const salt = s1(Buffer.from("smk4"));
  const T = aesCmac(salt, appKey);
  // SALT_K4_M = "id6\x01" = [0x69, 0x64, 0x36, 0x01]
  const result = aesCmac(T, Buffer.from([0x69, 0x64, 0x36, 0x01]));
  return result[15] & 0x3f;
}

function aesCcmEncrypt(key: Buffer, nonce: Buffer, plaintext: Buffer, micLen: number): Buffer {
  const cipher = crypto.createCipheriv("aes-128-ccm", key, nonce, { authTagLength: micLen });
  cipher.setAAD(Buffer.alloc(0), { plaintextLength: plaintext.length });
  const ct = cipher.update(plaintext);
  cipher.final();
  return Buffer.concat([ct, cipher.getAuthTag()]);
}

// ─── Packet construction ─────────────────────────────────────────────────────

// Serialize opcode as little-endian bytes (matching AccessLayerPDU.java toByteArray)
function opcodeBytes(op: number): Buffer {
  const firstByte = op & 0xff;
  if (firstByte < 0x80) return Buffer.from([firstByte]); // 1-byte opcode
  if (firstByte < 0xc0) return Buffer.from([firstByte, (op >> 8) & 0xff]); // 2-byte opcode
  return Buffer.from([firstByte, (op >> 8) & 0xff, (op >> 16) & 0xff]); // 3-byte opcode
}

// Application nonce (13 bytes) — NonceGenerator.java generateAccessNonce()
function appNonce(seq: number, src: number, dst: number, ivIndex: number): Buffer {
  return Buffer.from([
    0x01, // application nonce type
    0x00, // SZMIC=0 << 7
    (seq >> 16) & 0xff,
    (seq >> 8) & 0xff,
    seq & 0xff,
    (src >> 8) & 0xff,
    src & 0xff,
    (dst >> 8) & 0xff,
    dst & 0xff,
    (ivIndex >> 24) & 0xff,
    (ivIndex >> 16) & 0xff,
    (ivIndex >> 8) & 0xff,
    ivIndex & 0xff,
  ]);
}

// Network nonce (13 bytes) — NonceGenerator.java generateNetworkNonce()
function netNonce(ctl: number, ttl: number, seq: number, src: number, ivIndex: number): Buffer {
  return Buffer.from([
    0x00, // network nonce type
    (ctl << 7) | (ttl & 0x7f),
    (seq >> 16) & 0xff,
    (seq >> 8) & 0xff,
    seq & 0xff,
    (src >> 8) & 0xff,
    src & 0xff,
    0x00,
    0x00,
    (ivIndex >> 24) & 0xff,
    (ivIndex >> 16) & 0xff,
    (ivIndex >> 8) & 0xff,
    ivIndex & 0xff,
  ]);
}

// Proxy nonce (13 bytes) — BLE Mesh spec §3.8.5.4
// Same layout as network nonce but type=0x03, byte 1 is always 0x00 (no CTL/TTL).
function proxyNonce(seq: number, src: number, ivIndex: number): Buffer {
  return Buffer.from([
    0x03, // proxy nonce type
    0x00,
    (seq >> 16) & 0xff,
    (seq >> 8) & 0xff,
    seq & 0xff,
    (src >> 8) & 0xff,
    src & 0xff,
    0x00,
    0x00,
    (ivIndex >> 24) & 0xff,
    (ivIndex >> 16) & 0xff,
    (ivIndex >> 8) & 0xff,
    ivIndex & 0xff,
  ]);
}

// Build the full proxy PDU for a mesh access message
// Returns the bytes to write to PROXY_DATA_IN
function buildProxyPDU(
  appKey: Buffer,
  aid: number,
  nid: number,
  encKey: Buffer,
  privKey: Buffer,
  seq: number,
  src: number,
  dst: number,
  ivIndex: number,
  opcode: number,
  params: Buffer
): Buffer {
  // 1. Access PDU = opcode (LE) + params (LE)
  const accessPDU = Buffer.concat([opcodeBytes(opcode), params]);

  // 2. Encrypt access PDU with AppKey → Upper Transport PDU
  const upperEncrypted = aesCcmEncrypt(appKey, appNonce(seq, src, dst, ivIndex), accessPDU, 4);

  // 3. Lower Transport PDU = [AKF=1 | AID(6 bits)] + upper transport
  const lowerTransport = Buffer.concat([Buffer.from([0x40 | (aid & 0x3f)]), upperEncrypted]);

  // 4. Encrypt [DST + lowerTransport] with EncKey → encrypted network payload
  const netPayload = Buffer.concat([
    Buffer.from([(dst >> 8) & 0xff, dst & 0xff]),
    lowerTransport,
  ]);
  const ctl = 0;
  const encryptedPayload = aesCcmEncrypt(
    encKey,
    netNonce(ctl, DEFAULT_TTL, seq, src, ivIndex),
    netPayload,
    4
  );

  // 5. Obfuscate network header: (CTL|TTL, SEQ[2:0], SRC[1:0]) XOR PECB
  const ivi = ivIndex & 1;
  const pecb = computePECB(privKey, ivIndex, encryptedPayload.subarray(0, 7));
  const hdr = Buffer.from([
    (ctl << 7) | (DEFAULT_TTL & 0x7f),
    (seq >> 16) & 0xff,
    (seq >> 8) & 0xff,
    seq & 0xff,
    (src >> 8) & 0xff,
    src & 0xff,
  ]);
  const obfuscated = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) obfuscated[i] = hdr[i] ^ pecb[i];

  // 6. Network PDU = [IVI|NID] + obfuscated header + encrypted payload
  const networkPDU = Buffer.concat([Buffer.from([(ivi << 7) | (nid & 0x7f)]), obfuscated, encryptedPayload]);

  // 7. Proxy PDU = [SAR=0, TYPE=0] + Network PDU
  return Buffer.concat([Buffer.from([PROXY_TYPE_NETWORK]), networkPDU]);
}

// Proxy Configuration PDU (BLE Mesh spec §6.5) — sent BEFORE any mesh commands.
// The Telink SDK always sends Set Filter Type → waits for Filter Status → then Add Addresses
// before marking the connection ready. Without this handshake the proxy silently drops relayed PDUs.
// CTL=1, TTL=0, DST=0x0000, encrypted with EncKey + proxy nonce (type 0x03).
function buildProxyConfigPDU(
  nid: number,
  encKey: Buffer,
  privKey: Buffer,
  seq: number,
  src: number,
  ivIndex: number,
  opcode: number,
  params: Buffer
): Buffer {
  const ctl = 1;
  const ttl = 0;
  const dst = 0x0000;

  // Lower transport PDU: [SEG=0 | Opcode(7)] + params
  const transportPDU = Buffer.concat([Buffer.from([opcode & 0x7f]), params]);

  // Encrypt [DST | transportPDU] with proxy nonce, 4-byte MIC
  const netPayload = Buffer.concat([Buffer.from([(dst >> 8) & 0xff, dst & 0xff]), transportPDU]);
  const encrypted = aesCcmEncrypt(encKey, proxyNonce(seq, src, ivIndex), netPayload, 4);

  // Obfuscate header
  const ivi = ivIndex & 1;
  const pecb = computePECB(privKey, ivIndex, encrypted.subarray(0, 7));
  const hdr = Buffer.from([
    (ctl << 7) | (ttl & 0x7f),
    (seq >> 16) & 0xff,
    (seq >> 8) & 0xff,
    seq & 0xff,
    (src >> 8) & 0xff,
    src & 0xff,
  ]);
  const obfuscated = Buffer.alloc(6);
  for (let i = 0; i < 6; i++) obfuscated[i] = hdr[i] ^ pecb[i];

  const networkPDU = Buffer.concat([Buffer.from([(ivi << 7) | (nid & 0x7f)]), obfuscated, encrypted]);
  return Buffer.concat([Buffer.from([PROXY_TYPE_PROXY_CONFIG]), networkPDU]);
}

// PECB for header obfuscation — NetworkLayerPDU.java createPECB()
function computePECB(privKey: Buffer, ivIndex: number, privacyRandom7: Buffer): Buffer {
  const input = Buffer.alloc(16, 0);
  input[5] = (ivIndex >> 24) & 0xff;
  input[6] = (ivIndex >> 16) & 0xff;
  input[7] = (ivIndex >> 8) & 0xff;
  input[8] = ivIndex & 0xff;
  privacyRandom7.copy(input, 9, 0, 7);
  return aesEcbBlock(privKey, input);
}

// ─── Beacon parsing ───────────────────────────────────────────────────────────

// Parse IV index from a Secure Network Beacon notification
// Returns null if the data is not a valid beacon PDU
function parseIVIndexFromProxy(data: Buffer): number | null {
  if (data.length < 23) return null;
  const type = data[0] & 0x3f; // lower 6 bits
  if (type !== PROXY_TYPE_BEACON) return null;
  const beaconType = data[1];
  if (beaconType !== 0x01) return null; // Secure Network Beacon
  if (data.length < 23) return null;
  // Bytes 11-14 (1 proxy header + 1 beacon type + 1 flags + 8 networkID + 4 ivIndex)
  const ivIndex = data.readUInt32BE(11);
  return ivIndex;
}

// ─── Controller class ────────────────────────────────────────────────────────

class MeshController {
  private peripheral: any = null;
  private dataIn: any = null;
  private dataOut: any = null;
  private ivIndex = 0;
  // Random start in 12M–16M range: Python SDK uses ~9M, and previous runs leave cached seqs
  // on the lights. Being random avoids replay rejection between successive runs.
  private seq = parseInt(process.env.MESH_SEQ ?? '') || (12000000 + Math.floor(Math.random() * 4000000));

  private readonly aid: number;
  private readonly nid: number;
  private readonly encKey: Buffer;
  private readonly privKey: Buffer;

  constructor() {
    const derived = k2(NET_KEY);
    this.nid = derived.nid;
    this.encKey = derived.encKey;
    this.privKey = derived.privKey;
    this.aid = k4(APP_KEY);

    console.log(`Mesh keys derived — NID: 0x${this.nid.toString(16).padStart(2, "0")}, AID: 0x${this.aid.toString(16).padStart(2, "0")}`);
  }

  async connect(preferredMac?: string): Promise<boolean> {
    const self = this;
    return new Promise((resolve) => {
      console.log(`Scanning for Amaran lights (preferring relay hub ${RELAY_HUB_UUID})...`);
      let found = false;
      const candidates = new Map<string, any>(); // addr → peripheral, ordered by discovery

      noble.on("stateChange", async (state: string) => {
        if (state === "poweredOn") await noble.startScanningAsync([], true);
      });

      noble.on("discover", async (p: any) => {
        if (found) return;

        const addr = (p.address || p.id || "").toLowerCase().replace(/-/g, ":");
        const name = (p.advertisement.localName || "").toLowerCase();
        const advServices: string[] = (p.advertisement.serviceUuids || []).map((u: string) => u.toLowerCase());
        const hasMeshProxy = advServices.some(u => u === "1828" || u.startsWith("00001828"));
        const knownUUIDs = Object.values(LIGHTS).map(l => l.uuid.toLowerCase());
        const knownMacs = Object.values(LIGHTS).map(l => l.mac.toLowerCase().replace(/-/g, ":"));
        const isByUUID = knownUUIDs.includes(addr);
        const isByMac = knownMacs.includes(addr) || (preferredMac && addr === preferredMac.toLowerCase().replace(/-/g, ":"));
        const isByName = name.includes("slck") || name.includes("amaran") || name.includes("aputure");

        if (!hasMeshProxy && !isByUUID && !isByMac && !isByName) return;

        const isHub = addr === RELAY_HUB_UUID.toLowerCase();
        const matchType = hasMeshProxy ? "proxy-svc" : isByUUID ? "uuid" : isByMac ? "mac" : "name";
        console.log(`  Found: ${p.advertisement.localName || addr} (${addr}) [${matchType}]${isHub ? " ← relay hub" : ""}`);

        candidates.set(addr, p);

        // Connect to the relay hub immediately when seen; otherwise wait to accumulate
        if (isHub) {
          found = true;
          noble.stopScanningAsync();
          doConnect(p, addr).then(resolve);
        }
      });

      // After 5s, pick best candidate (hub > first found)
      const hubWait = setTimeout(async () => {
        if (found || candidates.size === 0) return;
        found = true;
        await noble.stopScanningAsync();
        const best = candidates.get(RELAY_HUB_UUID.toLowerCase()) ?? candidates.values().next().value;
        const addr = (best.address || best.id || "").toLowerCase().replace(/-/g, ":");
        doConnect(best, addr).then(resolve);
      }, 5000);

      setTimeout(async () => {
        clearTimeout(hubWait);
        if (!found) {
          await noble.stopScanningAsync();
          console.error("No Amaran lights found. Make sure the Amaran Desktop app is closed.");
          resolve(false);
        }
      }, 15000);

      async function doConnect(p: any, addr: string): Promise<boolean> {
        console.log(`Connecting to ${p.advertisement.localName || addr} (${addr})...`);
        try {
          await p.connectAsync();
          self.peripheral = p;

          const { characteristics } = await p.discoverSomeServicesAndCharacteristicsAsync(
            [PROXY_SERVICE], [PROXY_DATA_IN, PROXY_DATA_OUT]
          );

          for (const c of characteristics) {
            if (c.uuid === PROXY_DATA_IN) self.dataIn = c;
            if (c.uuid === PROXY_DATA_OUT) self.dataOut = c;
          }

          if (!self.dataIn || !self.dataOut) {
            console.error(`Mesh proxy chars not found. Run: npx tsx src/ble-scanner.ts connect ${addr}`);
            return false;
          }

          self.dataOut.on("data", (d: Buffer) => self.onNotify(d));
          await self.dataOut.subscribeAsync();
          console.log(`Connected to ${p.advertisement.localName || addr}`);
          return true;
        } catch (err) {
          console.error("Connection error:", err);
          return false;
        }
      }
    });
  }

  private ivResolve: ((iv: number) => void) | null = null;
  private beaconReceived = false;
  private filterStatusResolve: (() => void) | null = null;

  private onNotify(data: Buffer): void {
    const type = data[0] & 0x3f;
    console.log(`  ← notify [${data.length}b] type=0x${type.toString(16)} raw=${data.toString("hex")}`);

    if (type === PROXY_TYPE_PROXY_CONFIG) {
      // Proxy Configuration response — Filter Status (opcode 0x03) from the proxy node.
      // This confirms the proxy is ready to relay mesh messages from us.
      console.log(`  ← Proxy Filter Status received — proxy ready`);
      if (this.filterStatusResolve) {
        this.filterStatusResolve();
        this.filterStatusResolve = null;
      }
      return;
    }

    const iv = parseIVIndexFromProxy(data);
    if (iv !== null) {
      this.ivIndex = iv;
      this.beaconReceived = true;
      console.log(`  ← Secure Network Beacon — IV Index: 0x${iv.toString(16).padStart(8, "0")}`);
      if (this.ivResolve) {
        this.ivResolve(iv);
        this.ivResolve = null;
      }
    } else if (type === PROXY_TYPE_NETWORK) {
      console.log(`  ← Network PDU [${data.length}b]`);
    }
  }

  waitForBeacon(timeoutMs = 5000): Promise<number> {
    return new Promise((resolve) => {
      if (this.beaconReceived) { resolve(this.ivIndex); return; }
      const timer = setTimeout(() => {
        this.ivResolve = null;
        console.log("No beacon received; using IV index 0");
        resolve(0);
      }, timeoutMs);
      this.ivResolve = (iv) => { clearTimeout(timer); resolve(iv); };
    });
  }

  // Mirrors what the Telink SDK does in normalConnectPeripheral after subscribing to notifications:
  // 500ms delay → Set Filter Type (whitelist) → wait for Filter Status → Add Addresses.
  // Write With Response (withoutResponse=false) avoids CoreBluetooth's silent flow-control drop
  // that can silently discard Write Without Response commands.
  async setupProxyFilter(): Promise<void> {
    if (!this.dataIn) throw new Error("Not connected");

    // Match the Telink SDK's 500ms pause between notification subscribe and filter setup.
    await new Promise(r => setTimeout(r, 500));

    // 1. Set Filter Type = whitelist (0x00) — use Write With Response so the write is ACK'd
    const setFilterPDU = buildProxyConfigPDU(
      this.nid, this.encKey, this.privKey,
      this.nextSeq(), LOCAL_ADDRESS, this.ivIndex,
      PROXY_CFG_SET_FILTER_TYPE,
      Buffer.from([PROXY_FILTER_WHITELIST])
    );
    console.log(`  → Proxy: Set Filter Type = Whitelist  ${setFilterPDU.toString("hex")}`);
    await this.dataIn.writeAsync(setFilterPDU, true);

    // 2. Wait for Filter Status response (up to 2s)
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.filterStatusResolve = null;
        console.log("  No Filter Status response; proceeding anyway");
        resolve();
      }, 2000);
      this.filterStatusResolve = () => { clearTimeout(timer); resolve(); };
    });

    // 3. Add our provisioner address + broadcast to the whitelist so we receive status responses.
    const addrBuf = Buffer.alloc(6);
    addrBuf.writeUInt16BE(LOCAL_ADDRESS, 0);  // 0x0001
    addrBuf.writeUInt16BE(0xffff, 2);         // all-nodes broadcast
    addrBuf.writeUInt16BE(GROUP_ALL, 4);      // 0xC000
    const addAddrPDU = buildProxyConfigPDU(
      this.nid, this.encKey, this.privKey,
      this.nextSeq(), LOCAL_ADDRESS, this.ivIndex,
      PROXY_CFG_ADD_ADDRESSES,
      addrBuf
    );
    console.log(`  → Proxy: Add Addresses [0x0001, 0xFFFF, 0xC000]  ${addAddrPDU.toString("hex")}`);
    await this.dataIn.writeAsync(addAddrPDU, true);

    // Small settling gap before commands
    await new Promise(r => setTimeout(r, 300));
    console.log("Proxy filter configured — ready to send commands");
  }

  private nextSeq(): number {
    this.seq = (this.seq + 1) & 0xffffff;
    return this.seq;
  }

  private tid = 0;
  private nextTid(): number {
    this.tid = (this.tid + 1) & 0xff;
    return this.tid;
  }

  async send(dst: number, opcode: number, params: Buffer, retries = 3): Promise<void> {
    if (!this.dataIn) throw new Error("Not connected");
    for (let i = 0; i < retries; i++) {
      const seq = this.nextSeq();
      const pdu = buildProxyPDU(
        APP_KEY, this.aid, this.nid, this.encKey, this.privKey,
        seq, LOCAL_ADDRESS, dst, this.ivIndex,
        opcode, params
      );
      if (i === 0) console.log(`  → dst=0x${dst.toString(16).padStart(4,"0")} opcode=0x${opcode.toString(16).padStart(4,"0")} try=${i+1}/${retries} payload=${pdu.toString("hex")}`);
      else console.log(`    retry ${i+1} seq=${seq} payload=${pdu.toString("hex")}`);
      await this.dataIn.writeAsync(pdu, true);
      await new Promise(r => setTimeout(r, 80)); // small gap between retries
    }
  }

  async setOnOff(dst: number, on: boolean): Promise<void> {
    const val = on ? 0x01 : 0x00;
    const tid = this.nextTid();
    // Standard Generic OnOff Set Unacknowledged (NOACK) with optional fields explicit
    await this.send(dst, OP.ONOFF_SET_NOACK, Buffer.from([val, tid, 0x00, 0x00]));
  }

  // Build a 10-byte Telink proprietary command payload (reverse-engineered from PyMeshSDK.so).
  // Format: [checksum, 0×7_zeros_or_low_bits, cmd_value_low, cmd_type]
  // checksum = sum(bytes[1..9]) & 0xFF, stored at byte[0].
  private telinkPayload(cmdType: number, cmdValue: number): Buffer {
    const p = Buffer.alloc(10);
    p[8] = cmdValue & 0xff;
    p[9] = cmdType & 0xff;
    // Bytes 0-7 encode extra bits for high-precision values — zero for typical sleep/brightness
    let sum = 0;
    for (let i = 1; i < 10; i++) sum += p[i];
    p[0] = sum & 0xff;
    return p;
  }

  async setOnOffBlast(dst: number, on: boolean): Promise<void> {
    // Use Telink proprietary opcode 0x26 with sleep/wake payload (cmd_type=0x8C).
    // Verified by intercepting CBPeripheral.writeValue from PyMeshSDK.so:
    //   sendOnOffCommand(0xFFFF, True)  →  opcode=0x26, params=[0x8D,0,0,0,0,0,0,0,0x01,0x8C]
    const params = this.telinkPayload(0x8C, on ? 0x01 : 0x00);
    await this.send(dst, OP.TELINK_CMD, params, 3);
  }

  async setTelinkBrightness(dst: number, intensity: number): Promise<void> {
    // Brightness uses cmd_type=0x8F, cmd_value=(intensity>>2)&0xFF, intensity 0–1000.
    const clipped = Math.max(0, Math.min(1000, intensity));
    const params = this.telinkPayload(0x8F, (clipped >> 2) & 0xff);
    await this.send(dst, OP.TELINK_CMD, params, 3);
  }

  // Send Generic OnOff Get (acknowledged) — light MUST send back Generic OnOff Status
  // if encryption is correct. Watch for "← Network PDU received" in output.
  async getStatus(dst: number): Promise<void> {
    await this.send(dst, OP.ONOFF_GET, Buffer.alloc(0), 1);
    console.log("  Waiting 3s for status response...");
    await new Promise(r => setTimeout(r, 3000));
  }

  async setBrightness(dst: number, percent: number): Promise<void> {
    const lightness = Math.round(Math.max(0, Math.min(100, percent)) / 100 * 65535);
    const p = Buffer.alloc(3);
    p.writeUInt16LE(lightness, 0);
    p[2] = this.nextTid();
    await this.send(dst, OP.LIGHTNESS_SET_NOACK, p);
  }

  async setCCT(dst: number, brightnessPercent: number, kelvin: number): Promise<void> {
    const lightness = Math.round(Math.max(0, Math.min(100, brightnessPercent)) / 100 * 65535);
    const temp = Math.max(800, Math.min(20000, kelvin));
    const p = Buffer.alloc(7);
    p.writeUInt16LE(lightness, 0);
    p.writeUInt16LE(temp, 2);
    p.writeInt16LE(0, 4); // deltaUV
    p[6] = this.nextTid();
    await this.send(dst, OP.CTL_SET_NOACK, p);
  }

  async setHSL(dst: number, brightnessPercent: number, hueDeg: number, satPercent: number): Promise<void> {
    const lightness = Math.round(Math.max(0, Math.min(100, brightnessPercent)) / 100 * 65535);
    const hue = Math.round(((hueDeg % 360) / 360) * 65535);
    const sat = Math.round(Math.max(0, Math.min(100, satPercent)) / 100 * 65535);
    const p = Buffer.alloc(7);
    p.writeUInt16LE(lightness, 0);
    p.writeUInt16LE(hue, 2);
    p.writeUInt16LE(sat, 4);
    p[6] = this.nextTid();
    await this.send(dst, OP.HSL_SET_NOACK, p);
  }

  async disconnect(): Promise<void> {
    if (this.peripheral) {
      await this.peripheral.disconnectAsync();
      console.log("Disconnected");
    }
  }
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0];

  if (!cmd || cmd === "help") {
    console.log(`
Amaran BLE Mesh Controller — direct Bluetooth, no desktop app needed

Usage:
  npx tsx src/mesh-controller.ts <command> [args] [light]

Commands:
  on              Turn light on
  off             Turn light off
  brightness <n>  Set brightness 0-100
  cct <b> <k>     Set brightness (0-100) and colour temp (2500-7500K)
  hsl <b> <h> <s> Set brightness, hue (0-360°), saturation (0-100)

Light targets (optional, default = all):
  key             Key Light  (A4:C1:38:13:41:38, address 2)
  back            Back Light (A4:C1:38:13:30:86, address 4)
  halo            Halo 100x  (A4:C1:38:56:8C:EF, address 6)
  all             Broadcast to all (default)
`);
    return;
  }

  // Parse light target from last arg
  const lastArg = args[args.length - 1];
  const lightKeys = Object.keys(LIGHTS);
  let targetLight: string | undefined;
  let dstAddress = GROUP_ALL; // 0xC000 — the configured "All" group in amaran.db

  if (lightKeys.includes(lastArg)) {
    targetLight = lastArg;
    dstAddress = LIGHTS[targetLight].address;
    args.pop();
  } else if (lastArg === "all") {
    args.pop();
  }

  // Connect to the first Amaran light found via Mesh Proxy service scan.
  // We use the mesh DST address (not BLE connection) to target specific lights,
  // so it doesn't matter which physical device we connect to for BLE.
  const ctrl = new MeshController();

  if (!(await ctrl.connect())) process.exit(1);

  // Wait for IV index from Secure Network Beacon (device broadcasts this on connect)
  await ctrl.waitForBeacon(4000);

  // Proxy filter setup — send but don't block on the response
  await ctrl.setupProxyFilter();

  try {
    // Python SDK sends to 0xFFFF (all-nodes broadcast) for all-lights commands.
    const targets: number[] = targetLight
      ? [dstAddress]
      : [0xffff];

    switch (cmd) {
      case "status": {
        // Acknowledged GET — light MUST reply with Generic OnOff Status if encryption is correct
        const addr = targets[0];
        const name = Object.values(LIGHTS).find(l => l.address === addr)?.name ?? `0x${addr.toString(16)}`;
        console.log(`Querying ${name} status (acknowledged — watch for response)...`);
        await ctrl.getStatus(addr);
        break;
      }
      case "on":
        for (const addr of targets) {
          const name = Object.values(LIGHTS).find(l => l.address === addr)?.name ?? `0x${addr.toString(16)}`;
          console.log(`Turning ${name} ON (OnOff + Lightness + CTL)`);
          await ctrl.setOnOffBlast(addr, true);
        }
        break;
      case "off":
        for (const addr of targets) {
          const name = Object.values(LIGHTS).find(l => l.address === addr)?.name ?? `0x${addr.toString(16)}`;
          console.log(`Turning ${name} OFF`);
          await ctrl.setOnOffBlast(addr, false);
        }
        break;
      case "brightness": {
        const pct = parseInt(args[1], 10);
        if (isNaN(pct)) { console.error("Usage: brightness <0-100>"); process.exit(1); }
        for (const addr of targets) {
          const name = Object.values(LIGHTS).find(l => l.address === addr)?.name ?? `0x${addr.toString(16)}`;
          console.log(`Setting ${name} brightness to ${pct}%`);
          await ctrl.setBrightness(addr, pct);
        }
        break;
      }
      case "cct": {
        const b = parseInt(args[1], 10);
        const k = parseInt(args[2], 10);
        if (isNaN(b) || isNaN(k)) { console.error("Usage: cct <brightness 0-100> <kelvin 2500-7500>"); process.exit(1); }
        for (const addr of targets) {
          const name = Object.values(LIGHTS).find(l => l.address === addr)?.name ?? `0x${addr.toString(16)}`;
          console.log(`Setting ${name} CCT — ${b}% brightness, ${k}K`);
          await ctrl.setCCT(addr, b, k);
        }
        break;
      }
      case "hsl": {
        const b = parseInt(args[1], 10);
        const h = parseInt(args[2], 10);
        const s = parseInt(args[3], 10);
        if (isNaN(b) || isNaN(h) || isNaN(s)) { console.error("Usage: hsl <brightness 0-100> <hue 0-360> <saturation 0-100>"); process.exit(1); }
        for (const addr of targets) {
          const name = Object.values(LIGHTS).find(l => l.address === addr)?.name ?? `0x${addr.toString(16)}`;
          console.log(`Setting ${name} HSL — ${b}% brightness, ${h}° hue, ${s}% saturation`);
          await ctrl.setHSL(addr, b, h, s);
        }
        break;
      }
      default:
        console.error(`Unknown command: ${cmd}. Run with 'help' to see usage.`);
        process.exit(1);
    }

    await new Promise((r) => setTimeout(r, 2000));
  } finally {
    await ctrl.disconnect();
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
