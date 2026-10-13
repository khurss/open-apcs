# GOOUUU ESP32 bench record

## Scope and authorization

The owner selected the onboard LED, supplied a local Wi-Fi network, and explicitly declined backup of the existing firmware. No external actuator is part of this bench. Board revision markings are unavailable. A published [GOOUUU example](https://gist.github.com/motojinc25/85241d01420e592dcafd7bf00db46b08) uses GPIO5; this is an identification candidate until visually confirmed on this specific board. Firmware acknowledgement is not independent optical feedback.

## Hardware and deployment

On 2026-10-13, the pinned ESP-IDF Docker tools identified an ESP32-D0WDQ6 revision 1.0, 40 MHz crystal and 4 MiB flash through a CP2102 USB adapter. Read-only eFuse inspection reported secure boot and flash encryption disabled. No eFuse was programmed. The generated partition table was reviewed: NVS at `0x9000`, size `0x6000`, factory application at `0x10000`. The application/bootloader/partition/NVS writes were hash-verified by esptool. The conservative generated 2 MiB firmware layout fits the detected 4 MiB chip.

The firmware joined the owner's WPA2 network, obtained a DHCP lease, synchronized with a local time service and connected to the separate MQTT 5 TLS broker using its individual account. Internet access is not required by those device services. Network credentials, CA keys, private configuration, raw serial logs and NVS artifacts remain outside the repository under `~/.local/share/open-apcs/esp32-bench`, with private credentials restricted to their owner. The unencrypted NVS image must remain private.

The physical broker is separate from the simulation broker, uses a private CA and per-device exact-topic ACLs, and publishes only TLS port 8883 on the server LAN address. The local time container uses a pinned `cturra/ntp` image with a private Chrony configuration and serves the server clock as isolated stratum 10. It does not change the host clock or contact public time services. Correct host time remains an operator responsibility; the host reported synchronized time during commissioning. This is a bench time source, not an independent precision reference. See [Chrony configuration](https://chrony-project.org/doc/4.8/chrony.conf.html) and [the container source](https://github.com/cturra/docker-ntp).

Both services are managed by the private `compose.yml` in the bench directory. The API's private `compose.api.yml` mounts only its physical configuration, preserving the existing HTTPS LAN profile. Restart commands on this workstation are:

```sh
docker compose -f ~/.local/share/open-apcs/esp32-bench/compose.yml up -d --wait
docker compose --env-file .env.lan -f compose.yml -f compose.lan.yml \
  -f ~/.local/share/open-apcs/esp32-bench/compose.api.yml up -d --no-build --wait api web
```

Running plain `make lan` omits this explicit physical override. API/worker restarts never rearm a device. After firmware Wi-Fi/MQTT loss, reboot the board before explicit rearming. The current firmware deliberately does not reconnect automatically.

## Hardware-discovered transport issue

Initial commissioning failed safely with output OFF. Direct observation showed a valid `ready` reply arriving around 1.07 seconds after the request, exceeding the unchanged 500 ms confirmation deadline; occasional snapshots were also late. The pinned ESP-MQTT source showed that `esp_mqtt_client_enqueue` queues a reply while its task can remain in the default 1000 ms transport poll. Native protocol tests cannot expose this embedded task scheduling delay.

The firmware now selects the supported `CONFIG_MQTT_USE_CUSTOM_CONFIG` and a 20 ms `CONFIG_MQTT_POLL_READ_TIMEOUT_MS`, with a build-time bound, and disables Wi-Fi power saving for the USB-powered bench. Gateway freshness, lease and expiry rules are unchanged. Temporary serial diagnostics are removed from the final build.

The hardware trace also exposed a second boundary: fractional clock values can produce lease deadlines that round differently between JavaScript JSON and cJSON. A compiled-C/TypeScript regression reproduced the invalid confirmation. The gateway now proposes an integer-millisecond deadline rounded down, and preserves exact equality on the device confirmation. The lease becomes less than 1 ms shorter; the change does not permit late replies or lengthen control authority.

The physical broker also requires `set_tcp_nodelay true` for this measured bench configuration. Mosquitto otherwise defaults to Nagle buffering; see [the broker configuration reference](https://mosquitto.org/man/mosquitto-conf-5.html). With the firmware fixes alone, eight of ten diagnostic handshakes passed and two exceeded freshness limits. After enabling TCP_NODELAY and restarting the broker and board, ten of ten handshakes passed: snapshot replies took 54–76 ms and ready replies took 100–115 ms after their respective requests. These are a small observed sample, not latency guarantees. Deadline checks were not relaxed.

## Observed result and remaining acceptance

The live HTTPS browser workflow completed 30 alternating GPIO5 ON/OFF commands through the API, durable journal, TLS broker and physical ESP32. Every command reached `Verified`, and the final command was OFF. The owner then reported that the onboard LED did **not** blink. GPIO5 is therefore not confirmed as this board's LED pin. Firmware acknowledgements establish the command path, not independently measured GPIO voltage or visible light. Photos of both sides or an exact board schematic are needed before choosing another pin.

A later runtime renewal failed closed before the broker latency adjustment; the API profile was explicitly stopped. The final diagnostic handshakes sent no output commands, observed output false, and their leases expired. The device remains disarmed. The final broker setting has handshake evidence only; the complete browser control run has not been repeated with it.

Final Docker validation passed 535 unit/integration tests, six Chromium scenarios, 420 native C checks, ESP32 cross-compilation, renderer recovery, TypeScript, English validation, frontend/offline dependency builds and database backup/restore. No tool image was rebuilt.

Visual LED mapping/polarity, independent watchdog/output timing, network interruption/reconnect behavior, power-cycle behavior and the one-hour L0 profile remain unverified. USB flashing, Wi-Fi/TLS connection and firmware acknowledgements do not complete M1 or physical LED acceptance.
