# ESP-IDF patches

These patch the ESP-IDF BLE Mesh core. They are **required** for the
inbound status-snoop feature and live here because ESP-IDF is installed
outside this repo (`~/esp/esp-idf`), so the changes would otherwise be lost
on a reinstall or a different machine.

Tested against **ESP-IDF v5.3.2**.

## 0001-amaran-net-recv-status-snoop.patch

Adds a passive snoop in `components/bt/esp_ble_mesh/core/net.c`. Telink
fixtures route their `0x26` status replies to the provisioner unicast
`0x0001`, never to whoever requested status, so the normal access-layer
dispatch never delivers them to this node. The patch decrypts a *copy* of
the access payload in `bt_mesh_net_recv` (right after network decode,
before the relay path) and hands the plaintext to the firmware via the
weak hook `amaran_mesh_access_rx()`, which `main/main.c` implements. The
relay path is untouched, so ESP32->desktop refresh still works.

There is no public ESP-IDF callback for "raw decoded network PDU", so
patching net.c is unavoidable.

### Apply

```sh
cd ~/esp/esp-idf
git apply /path/to/esp32-firmware/patches/0001-amaran-net-recv-status-snoop.patch
```

Then rebuild the firmware (`idf.py build`). To regenerate this patch after
further edits:

```sh
cd ~/esp/esp-idf
git diff -- components/bt/esp_ble_mesh/core/net.c \
  > /path/to/esp32-firmware/patches/0001-amaran-net-recv-status-snoop.patch
```
