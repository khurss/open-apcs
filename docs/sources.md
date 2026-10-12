# Technical sources

Primary documentation reviewed during specification preparation on October 12, 2026. Sources establish technology capabilities and limitations; proposed frequencies, architecture, and limits are project decisions, not requirements imposed by these sources.

| Source | Use |
|---|---|
| [Arm Mbed](https://github.com/ARMmbed) | End of Mbed support in July 2026; Mbed CE community direction; separate Mbed TLS status |
| [Arduino CLI integration](https://docs.arduino.cc/arduino-cli/integration-options/) | Local compile/upload operations, CLI and gRPC |
| [React Flow](https://reactflow.dev/) | Graph editor library with an MIT-licensed core; not an execution engine |
| [Node.js Release Working Group](https://github.com/nodejs/Release) | LTS branches and lifecycle; basis for selecting a supported Node.js version |
| [Node.js vm](https://nodejs.org/api/vm.html) | `node:vm` is not a security mechanism |
| [Fastify TypeScript](https://fastify.dev/docs/latest/Reference/TypeScript/) | Application API typing |
| [MQTT 5 OASIS](https://docs.oasis-open.org/mqtt/mqtt/v5.0/mqtt-v5.0.html) | QoS, retained messages, expiry; need for separate application command rules |
| [ESPHome MQTT](https://esphome.io/components/mqtt/) | State, command topics, and availability through MQTT |
| [Zigbee2MQTT MQTT API](https://www.zigbee2mqtt.io/guide/usage/mqtt_topics_and_messages.html) | Local device/bridge request/response topics |
| [Modbus Organization](https://www.modbus.org/modbus-specifications) | Application protocol and transport specifications |
| [Zephyr board catalog](https://docs.zephyrproject.org/latest/boards/) | Firmware support depends on specific boards/targets |
| [Espressif QEMU](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-guides/tools/qemu.html) | ESP32 CPU, memory, and partial peripheral emulation; separate from hardware testing |
| [ESP-IDF OTA](https://docs.espressif.com/projects/esp-idf/en/stable/esp32/api-reference/system/ota.html) | OTA partitions, application verification, rollback |
| [PostgreSQL partitioning](https://www.postgresql.org/docs/current/ddl-partitioning.html) | Partitioning of the initial history store |
| [Playwright Docker](https://playwright.dev/docs/docker) | Container browser tests |
| [IEC overview of IEC 62443](https://syc-se.iec.ch/deliveries/cybersecurity-guidelines/security-standards-and-best-practices/iec-62443/) | IACS security lifecycle and zones/conduits as architectural guidance |
| [IEC 61511 preview](https://webstore.iec.ch/en/iec_catalog/product/preview/?id=L3B1Yi9wZGYvcHJldmlldy9pbmZvX2llYzYxNTExLTF7ZWQyLjB9Yi5wZGY%3D) | SIS functional safety as an independent requirements domain |

Public standards overviews do not replace normative texts or conformity assessment. This specification does not claim SIL, IEC 62443 certification, or full IEC 61131-3 compatibility. The customer agreed to the boundary between ordinary control and independent protections.

Local primary sources and the function map are in the [legacy analysis](legacy-analysis.md). Legacy sources are used to study behavior; copying their code, symbols, or binary libraries into the new open-source product is not planned.
