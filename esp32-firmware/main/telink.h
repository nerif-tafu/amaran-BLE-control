/*
 * Telink proprietary 0x26 vendor opcode payload builders.
 *
 * Reverse-engineered from PyMeshSDK.so by intercepting writeValue: calls
 * on the live mesh proxy. Mirror of the helpers in src/mesh-controller.ts:
 *  setOnOffBlast, setTelinkBrightness, setTelinkCCT, setTelinkHSI.
 */

#ifndef AMARAN_TELINK_H
#define AMARAN_TELINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Wire opcode for vendor PDUs: 0x26 | (company_id << 8) shifted into the
 * standard 3-byte vendor opcode form (first byte 0xC0..0xFF). For amaran
 * (Telink, company 0x0211) the opcode is BT_MESH_MODEL_OP_3-style encoded
 * as 0xC0 | 0x26, then company_id LE. */
#define AMARAN_VENDOR_COMPANY_ID 0x0211
#define AMARAN_VENDOR_OPCODE_BYTE 0x26

/* Compute the full 3-byte little-endian opcode value passed to
 * amaran_build_proxy_pdu(). The TS reference uses just 0x26 here because
 * its opcode_bytes() compresses; we keep the explicit 3-byte form so that
 * the params it carries match. */
#define AMARAN_TELINK_OPCODE_LE 0x26

/* All builders write 10 bytes to out[0..9]. Returns the same pointer for
 * chaining. */
uint8_t *amaran_telink_onoff(bool on, uint8_t out[10]);
uint8_t *amaran_telink_brightness(uint16_t intensity_0_1000, uint8_t out[10]);
/* gm_offset: green/magenta tint, -10..+10, 0 = neutral (negative greener,
 * positive more magenta). */
uint8_t *amaran_telink_cct(uint16_t kelvin, uint16_t intensity_0_1000,
                           int gm_offset, uint8_t out[10]);
uint8_t *amaran_telink_hsi(uint16_t hue_deg, uint8_t saturation_0_100,
                           uint16_t intensity_0_1000, uint8_t out[10]);

/* Telink status-request packet (cmd_type=0x0e). Fixture replies with its
 * current state. The reply broadcasts on the mesh adv channel, which is
 * what causes the iPad / desktop apps to refresh their UI — mirrors what
 * Aaron's `amaran status` command does and what his TUI's Shift+R loops
 * over every fixture. */
uint8_t *amaran_telink_status_request(uint8_t out[10]);

/* Decoded fixture status, parsed from a 0x26 status reply payload.
 * Reverse-engineered from live replies (and cross-checked against Aaron's
 * decodePacket): the fixture reports its *current mode* in command_type —
 * 0x02 = CCT, 0x01 = HSI/color — using the same bit-packing as the
 * corresponding setter. command_type 0x0a is a constant diagnostic page
 * (what the desktop polls) and is not decoded. */
typedef struct {
    bool valid;            /* false: checksum bad or command_type not state */
    bool on;               /* power: (low64 >> 8) & 1 */
    bool is_hs;            /* true: HSI/color (0x01); false: CCT (0x02) */
    uint16_t intensity;    /* 0..1000 (both modes) */
    uint16_t cct_kelvin;   /* CCT mode */
    int gm;                /* -10..+10, 0 neutral (CCT mode) */
    uint16_t hue;          /* 0..360 (HSI mode) */
    uint8_t sat;           /* 0..100 (HSI mode) */
    uint8_t command_type;  /* raw command_type (p[9] & 0x7f), for logging */
} amaran_status_t;

/* Decode the 10-byte Telink payload (p[0]=checksum .. p[9]=command_type).
 * Returns true and fills out only for decodable state replies (0x01/0x02
 * with a valid checksum); false otherwise. */
bool amaran_telink_decode_status(const uint8_t p[10], amaran_status_t *out);

#ifdef __cplusplus
}
#endif

#endif /* AMARAN_TELINK_H */
