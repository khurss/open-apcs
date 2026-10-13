# ESP-WROOM-32 LED firmware engineering profile

This profile uses a portable C state machine with an ESP-IDF 5.5.1 hardware application. The web application, services, and provisioning encoder remain TypeScript. ESP-IDF supplies the native Wi-Fi, TLS/MQTT, GPIO, and watchdog APIs. The tool image is pinned to an amd64 digest in `compose.test.yml`; it runs with the source bind mounted and networking disabled for tests/builds. No application image rebuild is required for firmware changes.

## Build and checks

Run `make firmware-test firmware-build`. Native C tests run with AddressSanitizer and UndefinedBehaviorSanitizer. A statically linked test peer is then compared with the TypeScript LED protocol by the integration suite. The native peer is a protocol test harness, not a CPU emulator or GPIO test. `make test` includes these checks and cross-compilation. `make firmware-watch` repeats native checks and incremental cross-compilation when firmware sources change; it never flashes hardware automatically.

Build artifacts are in `.cache/firmware-build/`. Generated sdkconfig and secrets are excluded from Git. The reproducible starting configuration is `firmware/esp32-led/sdkconfig.defaults`. A changed SDK configuration can require a full component rebuild; ordinary C edits use Ninja's incremental build. The pinned image is large and needs a one-time download or transfer from an offline bundle.

## Device behavior

A boot without valid local NVS provisioning never arms a GPIO. The profile allows only GPIO 5, 18, 19, 21, 22, 23, 25, 26, 27, 32, and 33; the bench operator must still verify the actual board wiring. Use an LED and current-limiting resistor, with an external pulldown where the startup state matters. Reset and ROM startup precede application GPIO configuration, so a software default does not establish a physical power-on safety guarantee.

Provisioned output starts OFF. The application uses WPA2-or-better Wi-Fi, MQTT 5 over TLS, a configured local CA, individual broker credentials, and a local SNTP server for certificate time validation. It does not fall back to plaintext MQTT or skip hostname verification. The broker must enforce per-device topic ACLs. No public time service is hard-coded.

The LED protocol uses a fresh boot ID, correlated probe/lease handshake, monotonic command deadlines, and a maximum three-second lease. A 10 ms control task ticks the watchdog independently of incoming packets. Task watchdog timeout is two seconds with panic/reset enabled. These are configured software intervals; physical timing and clock drift must be measured on the bench.

The ingress queue holds four complete frames of at most 4096 bytes. Fragmented, oversized, wrong-topic, or overflowing transport input faults the transport and removes output authority. Retained frames are rejected. JSON recursion is bounded to eight levels. The pinned SDK uses a custom 20 ms MQTT transport poll interval so asynchronous queued replies do not wait for its default one-second poll. A compile-time assertion enforces that bound. Wi-Fi power saving is disabled for this USB-powered bench. These settings do not guarantee real-time delivery; the existing gateway deadlines still reject delayed replies. The MQTT outbox is capped at 16 KiB; publications use QoS 1, no retain, and a one-second message expiry. Output is applied before publishing its acknowledgement. An acknowledgement reflects the configured GPIO output operation, not an independently measured actuator position.

Telemetry is queued immediately when the applied output differs from the last reported value, with an unchanged-state heartbeat after one second. This includes a lease-expiry transition to OFF while transport remains available. The control task applies GPIO before emitting the changed-state report; enqueue failure still latches the transport fault. Telemetry does not replace the separate command acknowledgement or provide independent electrical feedback.

Connection loss clears the session and forces OFF. There is no automatic Wi-Fi/MQTT reconnection in this initial bench profile; reboot and a fresh lease are required. A transport/clock fault cannot restore output authority. A bounded cache preserves the first result for up to 128 still-valid applied commands; expired entries are removed without changing the output, while live entries are never evicted for capacity. A conflicting live ID fails and an identical retry does not change the output. The authenticated gateway journal must never repurpose IDs or deadlines. See [command retention and its trust boundary](led-command-retention.md). Real-time endurance and physical acceptance remain pending.

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

USB flashing requires an explicitly selected serial device, the generated flash arguments, and the reviewed NVS partition offset/size. No USB device is mounted by the ordinary test/build services. The application supports explicit LED bench commissioning through a private gateway allowlist and owner review. Registration alone never arms a device. Broker credentials, ACLs, local time and certificates must be provisioned separately. Guided USB flashing/recovery, OTA, secure boot/flash encryption, and complete HIL acceptance remain subsequent work.

## Evidence boundary and sources

Native protocol checks and cross-compilation do not establish hardware behavior. Physical LED operation, reset outputs, Wi-Fi loss, clock bounds, and watchdog response require HIL on the actual board. A GOOUUU ESP32-D0WDQ6 rev.1 with 4 MiB flash was detected and flashed through USB on 2026-10-13; see [the bench record](goouuu-bench.md). M1 remains partial until its physical and load gates pass.

API choices follow the pinned [ESP-MQTT documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32/api-reference/protocols/mqtt.html) and [ESP-IDF container guide](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32/api-guides/tools/idf-docker-image.html). MQTT application deadlines and deduplication are still necessary because QoS 1 transport can retransmit messages.

The server/browser commissioning workflow is documented in [physical commissioning](physical-commissioning.md). It has TLS protocol-simulator coverage; the first physical board is now connected and undergoing bench verification.

## GOOUUU onboard LED bench

GPIO5 is an explicit exception for onboard LED identification on GOOUUU ESP32 boards. It is a strapping pin and must not be used as a general actuator output. The owner requested the onboard LED with no external load; the published [GOOUUU blink example](https://gist.github.com/motojinc25/85241d01420e592dcafd7bf00db46b08) uses GPIO5, but board revisions differ. The exact board must be visually checked: a firmware acknowledgement alone does not establish the LED mapping, polarity, or reset behavior. Other previously excluded strapping pins remain forbidden. The commissioning acknowledgement, exact private GPIO allowlist and lease checks still apply.

The first connected board did not visibly blink during the GPIO5 trial. Its LED mapping remains unconfirmed and its control profile is stopped; see [the measured result and remaining acceptance](goouuu-bench.md#observed-result-and-remaining-acceptance).

The owner subsequently confirmed visible blinking of an external LED on GPIO18 through the live web command path. The private bench now selects GPIO18 and is disarmed after verification; see [external LED verification](goouuu-bench.md#external-gpio18-led-verification). The onboard LED mapping remains unresolved.
