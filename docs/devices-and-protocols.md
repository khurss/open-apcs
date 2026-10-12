# Devices, protocols, and simulation

The customer selected MQTT, Modbus TCP/RTU, HTTP, serial ports, ESPHome, Zigbee, and BLE. These integrations are part of the product plan; their implementation order does not imply that support already exists. The first physical bench is an ESP-WROOM-32 with LEDs.

## 1. What device support means

Distinguish MCU architecture, chip family, specific board, firmware framework, and protocol. Arduino and mbed are software ecosystems; STM32 and ESP32 are microcontroller families. Implementing MQTT does not prove correct control of every MQTT device.

Document each supported combination:

- Manufacturer, board/chip model, hardware revision, firmware/framework, and driver version.
- Transport, read/write capabilities, data types, rate and message-size limits.
- Command acknowledgements, deduplication, device time, watchdog, readback, OTA, and recovery capabilities.
- GPIO/peripheral profile, prohibited assignments, and electrical compatibility rules from board documentation.
- Build, simulator, contract, and hardware test results.

Support levels: `Planned`, `Build-tested`, `Simulator-tested`, `Hardware-verified`, `Community-maintained`, and `Deprecated`. Installing a package or compiling successfully does not establish `Hardware-verified` status.

## 2. Protocol matrix

| ID | Integration | Capabilities and required checks | Phase |
|---|---|---|---|
| PR-01 | MQTT 5 / 3.1.1 | Broker ACL, TLS where possible, topic/payload mapping, birth/will, retain, QoS, reconnect, duplicates, stale data, commands and application ACK | First end-to-end release |
| PR-02 | HTTP/REST | JSON polling, webhook ingress, methods/headers, secretRef, timeouts, size limits, allowed endpoints | Integration expansion; the platform HTTP API comes earlier |
| PR-03 | Serial | Configurable baud/parity/stop bits, framing, CRC, timeouts, port reopening, custom I/O profiles | Expansion; USB flashing is available for the first ESP32 |
| PR-04 | Modbus TCP | Coils/registers, batch reads, unit ID, signed/float/word order, readback, exception codes | Integration expansion |
| PR-05 | Modbus RTU | Same mappings, one concurrent request per bus, turnaround/timeouts, CRC, USB/RS-485 disconnection | Integration expansion |
| PR-06 | ESPHome MQTT | State, availability, and commands through a standard adapter; profile-specific limits; no Home Assistant requirement | After the custom ESP32 path |
| PR-07 | Zigbee through Zigbee2MQTT | Local coordinator and bridge, catalog/exposes, read/write mappings, availability, explicitly enabled pairing | Home integration expansion |
| PR-08 | BLE | Discovery, advertisements, profile-based GATT read/write/notify, reconnect, pairing, sleeping-device constraints | Home integration expansion |
| PR-09 | OPC UA, S7, CAN/CANopen, BACnet, KNX, IEC 60870-5-104, DNP3 | Separate future drivers after selecting relevant devices and assessing libraries | Future roadmap, not promised for the first release |

I²C, SPI, UART, and 1-Wire are local firmware/gateway peripheral interfaces. Their support belongs to a specific board profile, not a claim of universal server connectivity.

## 3. Driver contract

A driver declares a manifest containing `id`, `version`, `apiVersion`, `license`, `configSchema`, `capabilities`, `permissions`, `supportedProfiles`, and limits. Basic operations:

| Operation | Behavior |
|---|---|
| `validateConfig` | Validate before connection without changing equipment |
| `connect` / `disconnect` | Controlled lifecycle and status reporting |
| `browse` | Optional discovery and available addresses |
| `read` / `subscribe` | Normalized samples with quality and timestamps |
| `write` | Command ID, deadline, value, current session; result with an evidence level |
| `health` | Connection age, errors, queues, latency, protocol-specific diagnostics |
| `shutdown` | Finish active operations and transition according to policy |

Read retries and reconnects use backoff/jitter. Write retries have a separate policy depending on idempotency and device deduplication. Unsupported operations return an explicit result; drivers must not fabricate acknowledgements.

One protocol driver's failure must not stop the others. Network and USB access are permission-limited. Equipment profiles are data, not arbitrary code; codecs and drivers are separate versioned packages with tests.

## 4. MQTT and the custom ESP32

Recommended topic tree:

```text
openapcs/v1/{siteId}/{deviceId}/hello
openapcs/v1/{siteId}/{deviceId}/availability
openapcs/v1/{siteId}/{deviceId}/telemetry
openapcs/v1/{siteId}/{deviceId}/events
openapcs/v1/{siteId}/{deviceId}/commands
openapcs/v1/{siteId}/{deviceId}/acks
openapcs/v1/{siteId}/{deviceId}/config/request
openapcs/v1/{siteId}/{deviceId}/config/status
```

`hello` reports boot/session ID, firmware, manifest capabilities, and the active configuration checksum. Broker credentials restrict each device to its own topics. Discovery never grants permissions automatically.

Telemetry batches multiple signals per device and includes sequence/boot ID. A retained snapshot may represent the last known value, but does not prove current connectivity. Availability combines will, heartbeat, last sample time, and session state. After reconnect, reconcile the snapshot before enabling commands.

Publish `commands` and other state-changing requests without retain. MQTT 5 uses Message Expiry; application freshness validation is mandatory, including for 3.1.1. Select QoS by stream type: events/ACK usually use QoS 1 with deduplication; ordinary telemetry may use QoS 0 or 1. See the [MQTT specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html).

The baseline firmware is a remote I/O agent. It does not execute user process-logic graphs. Local functions include GPIO, measurements, profile-based debounce, bounded pulses/PWM, watchdog, startup state, command validation, configuration, and diagnostics.

The initial bench uses Wi-Fi/MQTT and USB for initial flashing/recovery; GPIO assignments belong to demo configuration. ESP-WROOM-32 is a module, so the development-board profile and LED wiring must be established separately. Configure active-high/active-low explicitly; do not infer pins from the module name.

## 5. Provisioning, configuration, and OTA

1. Create a device profile and assign allowed channels/pins, startup values, and connection-loss policies.
2. Build a local firmware artifact in a pinned toolchain container or select a verified artifact.
3. Flash through the explicitly selected gateway/flasher USB port. Never automatically flash every discovered serial device.
4. Transfer individual credentials through a local provisioning channel. Secrets must not appear in build logs or project exports.
5. After connection, verify identity, capabilities, and configuration; test the LED in Commissioning mode.
6. OTA uses a manifest with model, versions, digest, and signature. The device checks compatibility and integrity; updates cannot start in a process mode that prohibits them.
7. Provide A/B partitions and post-start health verification for custom ESP32 firmware where the selected layout and flash capacity allow it. Failed verification restores the previous image; USB remains the recovery path.

Test power/network loss during OTA. Firmware updates and graph publication are separate operations. Do not reassign pins live without assessing active outputs. Secure boot and flash encryption belong to a separate profile: do not automatically enable irreversible hardware settings on the home development board.

Partition handling, application verification, and rollback must follow the selected [ESP-IDF OTA](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/ota.html) version, with separate tests of the custom flash layout.

## 6. ESPHome, Zigbee, and BLE

Integrate ESPHome initially through MQTT state/availability normalization and command mapping. This is supported by ESPHome itself; see its [MQTT component](https://esphome.io/components/mqtt/). The platform generates/validates a suitable configuration profile and performs local builds when GPIO changes require recompilation. Universal hot reconfiguration is not promised.

Each ESPHome profile must separately verify watchdog and restart policies. Without them, monitoring is allowed while control is restricted by application class. External devices do not universally support command IDs or application ACK; the UI must expose these limits.

Connect Zigbee through local Zigbee2MQTT and a supported coordinator. Read capabilities from the bridge and validate them against the profile. Pairing must be explicitly enabled and time-limited. See the [local bridge MQTT API](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html).

BLE requires a compatible radio adapter on the Linux gateway. Each GATT profile declares service/characteristic UUIDs, data types, endianness, units, and permissions. A sleeping device is not faulty merely because it lacks a continuous connection; its profile defines acceptable sample age. Measure concurrent BLE connection limits on the actual adapter.

## 7. Modbus and physical limits

Store protocol addresses as zero-based offsets; convert labels such as `40001` using an explicitly chosen convention. Number type, byte/word order, scale, offset, and range are required. Drivers declare supported function codes and cover them with contract tests. See [Modbus Organization documentation](https://www.modbus.org/modbus-specifications).

The scheduler combines compatible reads within allowed block sizes. RTU scheduling accounts for request/response sizes, line speed, gaps, and timeouts. A 1 Hz target across 10,000 devices cannot automatically apply to one serial line or radio coordinator; separate channels/gateways and bandwidth budgets are required.

A protocol write acknowledgement does not guarantee mechanism movement. Define a feedback signal and verification condition, or clearly show only protocol-level acknowledgement.

## 8. Board families and frameworks

| Family / framework | Integration path | Verification plan |
|---|---|---|
| ESP-WROOM-32 / ESP-IDF | Custom firmware, MQTT, USB provisioning, OTA | First LED hardware test |
| ESP32 / Arduino core | I/O SDK and MQTT/serial adapter | Example build and separate hardware tests |
| ESPHome / ESP32 | MQTT profile, local build/OTA | Separate contract suite and LED test |
| AVR / Arduino Uno/Mega | Compact serial/Modbus I/O profile through a gateway | Later; account for limited memory and lack of built-in networking |
| STM32 / STM32Cube, Arduino core, Zephyr | C/C++ SDK; serial/Ethernet/MQTT according to board capabilities | Select a specific board/toolchain combination |
| Other ARM, RP2040/RP2350 | Board-specific I/O adapter | After selecting priority models |
| Existing Mbed OS devices | Standard protocol or locally built adapter | Independent of former Arm online services |
| Mbed CE | Separate supported community toolchain profile | Candidate for new mbed projects; pin the version |

Arm states that Mbed support ended in July 2026 and points to Mbed CE as the community direction. This does not apply to Mbed TLS. See [Arm's official information](https://github.com/ARMmbed).

Arduino CLI can provide local build/upload operations through CLI/gRPC. This integrates a toolchain; it does not guarantee hardware compatibility. See the [official documentation](https://docs.arduino.cc/arduino-cli/integration-options/).

## 9. Simulation and emulation

The agreed order is virtual devices/process models first, actual firmware execution in a CPU emulator later. Development needs three verification layers:

| Layer | Reproduces | Does not prove |
|---|---|---|
| Virtual device | Pins, signals, MQTT/Modbus/serial contract, ACK, watchdog, disconnect/reconnect | Electrical characteristics or actual firmware execution |
| Process model | Tank, temperature, pump, delays, noise, sensor failure, scenarios | Physical accuracy without model validation |
| Physical ESP32 | Firmware, GPIO/LED, Wi-Fi, watchdog, reboot, OTA | Every future board model or industrial load |

Virtual clocks support pause, step, and acceleration; seeds make tests reproducible. Fault injection includes message loss/duplication/reordering, delays, frozen values, disconnection, invalid types, reboot, and counter reset. The same scenario can run through the test API and visually in the browser.

Execution of compiled firmware is a separate layer. Espressif provides QEMU support for ESP32 CPU, memory, and some peripherals; check coverage for the selected version. It does not replace Wi-Fi, electrical-output, or OTA testing on a physical board. See the [Espressif guide](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/qemu.html).

Simulation uses separate project/session namespaces and broker credentials that cannot publish to live control topics. Copying a project into simulation excludes live credentials and endpoints. A generator of 10,000 virtual devices is not a CPU emulator for 10,000 ESP32 boards; it tests platform load and contracts.
