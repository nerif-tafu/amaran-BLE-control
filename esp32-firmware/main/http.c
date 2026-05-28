#include "http.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "cJSON.h"
#include "esp_http_server.h"
#include "esp_log.h"

#include "mesh_config.h"
#include "wifi_config.h"

static const char *TAG = "amaran_http";

static const amaran_mqtt_dispatch_t *s_dispatch;
static httpd_handle_t s_server;

/* "all" / "broadcast" / "" → group address. Otherwise match a fixture key
 * or decimal/hex address. Returns 0 on hit, -1 on no match. */
static int resolve_key_or_addr(const char *s, uint16_t *out)
{
    if (s == NULL || *s == '\0' || strcmp(s, "all") == 0 ||
        strcmp(s, "broadcast") == 0) {
        *out = AMARAN_GROUP_ALL;
        return 0;
    }
    char *end;
    long v = strtol(s, &end, 0);
    if (*end == '\0' && v > 0 && v <= 0xffff) {
        *out = (uint16_t)v;
        return 0;
    }
    for (size_t i = 0; i < AMARAN_LIGHT_COUNT; i++) {
        if (strcmp(AMARAN_LIGHTS[i].key, s) == 0) {
            *out = AMARAN_LIGHTS[i].address;
            return 0;
        }
    }
    return -1;
}

static esp_err_t read_body(httpd_req_t *req, char *buf, size_t cap, size_t *out_len)
{
    if (req->content_len == 0) {
        *out_len = 0;
        buf[0] = '\0';
        return ESP_OK;
    }
    if (req->content_len >= cap) return ESP_FAIL;
    int got = httpd_req_recv(req, buf, req->content_len);
    if (got <= 0) return ESP_FAIL;
    buf[got] = '\0';
    *out_len = got;
    return ESP_OK;
}

static esp_err_t send_ok(httpd_req_t *req)
{
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, "{\"ok\":true}");
    return ESP_OK;
}

static esp_err_t send_err(httpd_req_t *req, int code, const char *msg)
{
    httpd_resp_set_status(req, code == 404 ? "404 Not Found"
                          : code == 400 ? "400 Bad Request"
                          : "500 Internal Server Error");
    httpd_resp_set_type(req, "application/json");
    char body[128];
    snprintf(body, sizeof(body), "{\"ok\":false,\"error\":\"%s\"}", msg);
    httpd_resp_sendstr(req, body);
    return ESP_OK;
}

/* POST /refresh — broadcast a status-request to every fixture so the
 * iPad/desktop apps catch up. Mirrors Aaron's Shift+R "refresh all". */
static esp_err_t refresh_all_post(httpd_req_t *req)
{
    s_dispatch->refresh(AMARAN_GROUP_ALL);
    return send_ok(req);
}

/* GET /lights — list known fixtures. */
static esp_err_t lights_get(httpd_req_t *req)
{
    cJSON *arr = cJSON_CreateArray();
    for (size_t i = 0; i < AMARAN_LIGHT_COUNT; i++) {
        const amaran_light_t *l = &AMARAN_LIGHTS[i];
        cJSON *item = cJSON_CreateObject();
        cJSON_AddStringToObject(item, "key", l->key);
        cJSON_AddStringToObject(item, "name", l->name);
        cJSON_AddNumberToObject(item, "address", l->address);
        char mac[18];
        snprintf(mac, sizeof(mac), "%02X:%02X:%02X:%02X:%02X:%02X",
                 l->mac[0], l->mac[1], l->mac[2], l->mac[3], l->mac[4], l->mac[5]);
        cJSON_AddStringToObject(item, "mac", mac);
        cJSON_AddItemToArray(arr, item);
    }
    char *out = cJSON_PrintUnformatted(arr);
    httpd_resp_set_type(req, "application/json");
    httpd_resp_sendstr(req, out);
    free(out);
    cJSON_Delete(arr);
    return ESP_OK;
}

/* Split "/lights/<key>/<action>" into its parts. uri excludes the leading
 * slash already (httpd_req_t->uri starts with '/'). Returns 0 on success. */
static int parse_lights_path(const char *uri, char *key, size_t key_cap,
                             char *action, size_t action_cap)
{
    /* Expect: /lights/<key>/<action> */
    if (strncmp(uri, "/lights/", 8) != 0) return -1;
    const char *p = uri + 8;
    const char *slash = strchr(p, '/');
    if (slash == NULL) return -1;
    size_t klen = slash - p;
    if (klen == 0 || klen >= key_cap) return -1;
    memcpy(key, p, klen);
    key[klen] = '\0';
    const char *q = slash + 1;
    const char *qend = strchr(q, '?');
    if (qend == NULL) qend = q + strlen(q);
    size_t alen = qend - q;
    if (alen == 0 || alen >= action_cap) return -1;
    memcpy(action, q, alen);
    action[alen] = '\0';
    return 0;
}

static esp_err_t lights_post(httpd_req_t *req)
{
    char key[32], action[16];
    if (parse_lights_path(req->uri, key, sizeof(key), action, sizeof(action)) != 0) {
        return send_err(req, 400, "bad path");
    }
    uint16_t dst;
    if (resolve_key_or_addr(key, &dst) != 0) {
        return send_err(req, 404, "unknown fixture");
    }

    char body[256];
    size_t bodylen = 0;
    if (read_body(req, body, sizeof(body), &bodylen) != ESP_OK) {
        return send_err(req, 400, "bad body");
    }

    if (strcmp(action, "on") == 0) {
        s_dispatch->on_off(dst, true);
        return send_ok(req);
    }
    if (strcmp(action, "off") == 0) {
        s_dispatch->on_off(dst, false);
        return send_ok(req);
    }
    if (strcmp(action, "refresh") == 0) {
        s_dispatch->refresh(dst);
        return send_ok(req);
    }

    /* Remaining actions need a JSON body. */
    cJSON *root = bodylen ? cJSON_Parse(body) : NULL;
    if (root == NULL) {
        return send_err(req, 400, "body must be JSON");
    }

    esp_err_t rc = ESP_OK;
    if (strcmp(action, "brightness") == 0) {
        cJSON *v = cJSON_GetObjectItemCaseSensitive(root, "value");
        if (!cJSON_IsNumber(v)) {
            rc = send_err(req, 400, "value: number 0-100");
        } else {
            int pct = v->valueint;
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            s_dispatch->brightness(dst, pct);
            rc = send_ok(req);
        }
    } else if (strcmp(action, "cct") == 0) {
        cJSON *k = cJSON_GetObjectItemCaseSensitive(root, "kelvin");
        cJSON *i = cJSON_GetObjectItemCaseSensitive(root, "intensity");
        cJSON *g = cJSON_GetObjectItemCaseSensitive(root, "gm");
        if (!cJSON_IsNumber(k) || !cJSON_IsNumber(i)) {
            rc = send_err(req, 400, "need {kelvin, intensity}");
        } else {
            int pct = i->valueint;
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            int gm = cJSON_IsNumber(g) ? g->valueint : 0;
            s_dispatch->cct(dst, k->valueint, pct, gm);
            rc = send_ok(req);
        }
    } else if (strcmp(action, "hsi") == 0) {
        cJSON *h = cJSON_GetObjectItemCaseSensitive(root, "hue");
        cJSON *sat = cJSON_GetObjectItemCaseSensitive(root, "sat");
        cJSON *i = cJSON_GetObjectItemCaseSensitive(root, "intensity");
        if (!cJSON_IsNumber(h) || !cJSON_IsNumber(sat) || !cJSON_IsNumber(i)) {
            rc = send_err(req, 400, "need {hue, sat, intensity}");
        } else {
            int pct = i->valueint;
            if (pct < 0) pct = 0;
            if (pct > 100) pct = 100;
            s_dispatch->hsi(dst, h->valueint, sat->valueint, pct);
            rc = send_ok(req);
        }
    } else {
        rc = send_err(req, 404, "unknown action");
    }
    cJSON_Delete(root);
    return rc;
}

int amaran_http_start(const amaran_mqtt_dispatch_t *dispatch)
{
    s_dispatch = dispatch;

    httpd_config_t cfg = HTTPD_DEFAULT_CONFIG();
    cfg.server_port = HTTP_PORT;
    cfg.uri_match_fn = httpd_uri_match_wildcard;

    if (httpd_start(&s_server, &cfg) != ESP_OK) {
        ESP_LOGE(TAG, "httpd_start failed");
        return -1;
    }

    static const httpd_uri_t r_list = {
        .uri = "/lights",
        .method = HTTP_GET,
        .handler = lights_get,
    };
    static const httpd_uri_t r_post = {
        .uri = "/lights/*",
        .method = HTTP_POST,
        .handler = lights_post,
    };
    static const httpd_uri_t r_refresh_all = {
        .uri = "/refresh",
        .method = HTTP_POST,
        .handler = refresh_all_post,
    };
    httpd_register_uri_handler(s_server, &r_list);
    httpd_register_uri_handler(s_server, &r_post);
    httpd_register_uri_handler(s_server, &r_refresh_all);

    ESP_LOGI(TAG, "http listening on :%d", HTTP_PORT);
    return 0;
}
