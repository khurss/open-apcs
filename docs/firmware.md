# ESP-WROOM-32 LED firmware engineering profile

This profile uses a portable C state machine with an ESP-IDF 5.5.1 hardware application. The web application, services, and provisioning encoder remain TypeScript. ESP-IDF supplies the native Wi-Fi, TLS/MQTT, GPIO, and watchdog APIs. The tool image is pinned to an amd64 digest in `compose.test.yml`; it runs with the source bind mounted and networking disabled for tests/builds. No application image rebuild is required for firmware changes.

## Build and checks

Run `make firmware-test firmware-build`. Native C tests run with AddressSanitizer and UndefinedBehaviorSanitizer. A statically linked test peer is then compared with the TypeScript LED protocol by the integration suite. The native peer is a protocol test harness, not a CPU emulator or GPIO test. `make test` includes these checks and cross-compilation. `make firmware-watch` repeats native checks and incremental cross-compilation when firmware sources change; it never flashes hardware automatically.

Build artifacts are in `.cache/firmware-build/`. Generated sdkconfig and secrets are excluded from Git. The reproducible starting configuration is `firmware/esp32-led/sdkconfig.defaults`. A changed SDK configuration can require a full component rebuild; ordinary C edits use Ninja's incremental build. The pinned image is large and needs a one-time download or transfer from an offline bundle.

## Device behavior

A boot without valid local NVS provisioning never arms a GPIO. The profile allows only GPIO 18, 19, 21, 22, 23, 25, 26, 27, 32, and 33; the bench operator must still verify the actual board wiring. Use an LED and current-limiting resistor, with an external pulldown where the startup state matters. Reset and ROM startup precede application GPIO configuration, so a software default does not establish a physical power-on safety guarantee.

Provisioned output starts OFF. The application uses WPA2-or-better Wi-Fi, MQTT 5 over TLS, a configured local CA, individual broker credentials, and a local SNTP server for certificate time validation. It does not fall back to plaintext MQTT or skip hostname verification. The broker must enforce per-device topic ACLs. No public time service is hard-coded.

The LED protocol uses a fresh boot ID, correlated probe/lease handshake, monotonic command deadlines, and a maximum three-second lease. A 10 ms control task ticks the watchdog independently of incoming packets. Task watchdog timeout is two seconds with panic/reset enabled. These are configured software intervals; physical timing and clock drift must be measured on the bench.

The ingress queue holds four complete frames of at most 4096 bytes. Fragmented, oversized, wrong-topic, or overflowing transport input faults the transport and removes output authority. Retained frames are rejected. JSON recursion is bounded to eight levels. The MQTT outbox is capped at 16 KiB; publications use QoS 1, no retain, and a one-second message expiry. Output is applied before publishing its acknowledgement. An acknowledgement reflects the configured GPIO output operation, not an independently measured actuator position.

Connection loss clears the session and forces OFF. There is no automatic Wi-Fi/MQTT reconnection in this initial bench profile; reboot and a fresh lease are required. A transport/clock fault cannot restore output authority. A bounded cache preserves the first result for up to 128 distinct applied command IDs per boot; a conflicting reuse fails, an identical retry does not change the output, and cache exhaustion refuses further new commands until reboot. This conservative initial bound is not the long-running production profile.

## Private USB provisioning preparation

Create a JSON file under `.cache/`, mode 0600, with exactly these fields:

| Field | Content |
|---|---|
| ssid, password | Local WPA2 network and passphrase |
| broker | `mqtts://<local-broker>:8883`, without embedded credentials |
| username, secret | Individual device broker credentials |
| site, device | Configured ASCII topic identifiers |
| gpio | One explicitly reviewed LED pin from the allowlist |
| ntp | Local SNTP host/address |
| ca | PEM certificate for the local broker's trust anchor |

Encode it without putting credentials in command arguments:

```sh
# Paths below are inside the bind-mounted container workspace.
docker compose -f compose.test.yml run --rm unit pnpm --filter @open-apcs/api firmware:provision /workspace/.cache/device.json /workspace/.cache/device.csv
```

The encoder validates fields, parses the certificate, writes a new mode-0600 CSV, and refuses overwriting. It does not flash a device. Convert the CSV with `docker compose -f compose.test.yml run --rm firmware-build sh /workspace/scripts/encode-nvs.sh /workspace/.cache/device.csv /workspace/.cache/device.bin 0x6000`, first confirming that 0x6000 matches the NVS size in the generated partition table. This wrapper uses ESP-IDF's generator, refuses overwrite, and keeps the output mode 0600. Keep the binary private: this initial profile does not encrypt NVS. Do not erase or overwrite an existing device's NVS without reviewing its contents and recovery plan.

USB flashing requires an explicitly selected serial device, the generated flash arguments, and the reviewed NVS partition offset/size. No USB device is mounted by the ordinary test/build services. The application currently has no physical commissioning API; registered ESP32 catalog entries remain unarmed. Broker credential/ACL deployment, a physical gateway, guided USB flashing/recovery, OTA, secure boot/flash encryption, and HIL acceptance remain subsequent work.

## Evidence boundary and sources

Native protocol checks and cross-compilation do not establish hardware behavior. Physical LED operation, reset outputs, Wi-Fi loss, clock bounds, and watchdog response require HIL on the actual board. The local server currently has no detected USB serial board. M1 remains partial until its physical and load gates pass.

API choices follow the pinned [ESP-MQTT documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32/api-reference/protocols/mqtt.html) and [ESP-IDF container guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32/api-guides/tools/idf-docker-image.html). MQTT application deadlines and deduplication are still necessary because QoS 1 transport can retransmit messages.

The server/browser commissioning workflow is documented in [physical commissioning](physical-commissioning.md). It has TLS protocol-simulator coverage; connecting and flashing the owner’s physical board is deferred at their request.
