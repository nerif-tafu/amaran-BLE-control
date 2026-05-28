/*
 * MQTT client + Home Assistant discovery.
 *
 * On connect: publishes one HA MQTT-discovery message per fixture under
 *   <ha_prefix>/light/<device_id>_<key>/config
 * with brightness + CCT support, then subscribes to the per-fixture
 * command topic. Each incoming command is parsed as JSON and dispatched
 * to the mesh-send callback registered here.
 */

#ifndef AMARAN_MQTT_H
#define AMARAN_MQTT_H

#include <stdbool.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Mesh command dispatch — provided by main.c. The MQTT layer calls these
 * after parsing an incoming HA command payload. */
typedef struct {
    void (*on_off)(uint16_t dst, bool on);
    void (*brightness)(uint16_t dst, int pct_0_100);
    /* gm: green/magenta tint, -50..+50, 0 = neutral. */
    void (*cct)(uint16_t dst, int kelvin, int pct_0_100, int gm);
    void (*hsi)(uint16_t dst, int hue_0_360, int sat_0_100, int pct_0_100);
    void (*refresh)(uint16_t dst);
} amaran_mqtt_dispatch_t;

int amaran_mqtt_start(const amaran_mqtt_dispatch_t *dispatch);
bool amaran_mqtt_is_connected(void);

#ifdef __cplusplus
}
#endif

#endif /* AMARAN_MQTT_H */
