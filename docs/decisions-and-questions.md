# Customer decisions and open parameters

Date: October 12, 2026. The requirements interview covered 40 questions. The answers below take precedence over initial recommendations. A recommendation is an architectural proposal, not an additional customer approval.

## 1. Answers and specification consequences

| No. | Customer decision | Consequence |
|---|---|---|
| 1 | A universal system for automation and control | Generic signals, assets, and logic; industry features in packages |
| 2 | Both editors are required | HMI and executable logic are separate, connected editors |
| 3 | Local server, completely without internet | No mandatory SaaS, CDN, or external authentication |
| 4 | Popular boards: ARV, ARM, ESP32, STM32, Arduino, mbed | Adapter ecosystem; ARV is assumed to mean AVR, not a separately confirmed architecture |
| 5 | Logic runs on the server/gateway; controllers provide I/O | Generating process logic into firmware is outside the baseline architecture |
| 6 | Up to 10 sites, 10,000 devices, one operator, approximately 1 Hz; hazardous processes are possible | Scalability and an explicit safety boundary are required |
| 7 | Start with an available ESP32 | Initial hardware acceptance on ESP32 |
| 8 | Both groups: MQTT/Modbus/HTTP/Serial and ESPHome/Zigbee/BLE | Include all in the target roadmap |
| 9 | Legacy system is a source of ideas and features only | No migration/import of legacy archives, screens, or protocols |
| 10 | Nodes/edges, FBD/SFC, and a text editor | Shared model, different views, phased delivery as in answer 27 |
| 11 | User JavaScript/TypeScript | Isolated script runner and local TypeScript editor |
| 12 | All listed logic functions matter | Timers, schedules, hysteresis, PID, counters, formulas, sequences, recipes, and alarms are in scope |
| 13 | Linux, everything in Docker, TypeScript where feasible, mandatory Docker TDD from the start | TypeScript application stack; C/C++ firmware and existing infrastructure services are exceptions |
| 14 | Recommend reliable, safe defaults; behavior must be configurable | Outputs remain unwritable until a policy is configured; local watchdog and equipment-specific policies |
| 15 | 10,000 devices total, 5–10 signals each; recommend frequencies | Target 50,000–100,000 signals; push/1 Hz, separate logic and UI cycles |
| 16 | Establish a standard baseline | Clarified in answer 24; this is not a certification request |
| 17 | First deliver ESP32 → signals → logic → screen → control | M1 provides a working path; full scale comes later |
| 18 | Record changes; raw data for 7 days, aggregates for one year | Deadband/checkpoints and separate aggregate retention policies |
| 19 | ESP-WROOM-32, LED debugging, simulation required | Physical LED bench and virtual devices |
| 20 | Custom firmware with GPIO/OTA configuration plus ESPHome | Two firmware/integration paths with separate capability matrices |
| 21 | English-only UI, two themes, responsive design | English UI; Unicode user data. The later repository-wide English instruction also applies to documentation |
| 22 | One operator initially | Collaborative editing is not initially required; authentication and audit remain |
| 23 | Virtual devices/process first; CPU firmware emulation later | Protocol/process simulator in M1; a QEMU-like layer in M5 |
| 24 | Ordinary control in the platform; independent critical protections; no SIL promise | Apply security/safety principles without claiming certification |
| 25 | Wi-Fi/MQTT; USB for initial flashing and recovery; configure demo GPIO later | Pin selection is not required during specification writing |
| 26 | Leave the license undecided | Do not invent a LICENSE; resolve the license before a licensed open-source release |
| 27 | Deliver small working increments | M0–M5; do not require the entire block library in M1 |
| 28 | Templates and local symbol/block/driver packages | LED, tank/pump, thermostat/PID; SDK and offline packages |
| 29 | Full audit, versions/diff/rollback, backups | Included even for one operator |
| 30 | SMTP and webhooks | Local notifications; external services are optional |
| 31 | Structured Text in future versions | Separate milestone with a documented supported subset |
| 32 | Publish individual graphs through controlled switching | Deployment scope, state migration checks, output ownership |
| 33 | Auto/Manual, interlocks, manual-command protection, and explanations | Shared enforcement for every control path |
| 34 | 4 CPUs, 16 GB RAM, 100 GB SSD, x86-64 | Initial benchmark host; its capacity is not equated with the full target scale |
| 35 | Restart, protections, and backups first; HA later | Single-server M1; automatic failover is not promised |
| 36 | Full offline installation, updates, builds, and packages | Bundle toolchains, packages, images, and documentation |
| 37 | PDF, CSV, summaries; choose good practices | Recommend daily/monthly templates and explicit aggregate semantics |
| 38 | Choose an appropriate gateway topology | Recommend one server initially; autonomous gateways after the working path and measurements |
| 39 | Full mobile monitoring/control; editors adapted within usability limits | Full mobile operator panels; complex engineering primarily on desktop/tablet |
| 40 | Name Open APCS; documentation set in the repository | Store specifications in `open-apcs/docs` |

Subsequent delivery instruction: translate all repository content into English before the first commit, publish to [khurss/open-apcs](https://github.com/khurss/open-apcs), and commit/push after each completed phase. This supersedes the initial choice to write documentation in the interview language. Publication does not select an open-source license or imply that M0 is complete.

## 2. Recommended architectural decisions

| ADR | Decision | Reason | Reconsider when |
|---|---|---|---|
| ADR-01 | React/TypeScript + Fastify/Node.js LTS; TypeScript runtime | One primary language, web editors, initial soft real-time model | Benchmarks identify a limit for a specific workload |
| ADR-02 | ESP-IDF C/C++ I/O firmware; separate ESPHome integration | MCU watchdog, predictable startup/OTA; platform remains TypeScript | Another firmware framework demonstrates a measured advantage |
| ADR-03 | Modular application with separate workers, Compose | Fits 4 CPU/16 GB host and simplifies operations | Load or distribution requires separate nodes |
| ADR-04 | PostgreSQL configuration/commands; replaceable Historian | Reliable transactions without committing every future archive to one technology | L2/L3 and disk budget require a specialized database |
| ADR-05 | One authoritative runtime per output | Prevent competing commands and split-brain | HA requires verified fencing |
| ADR-06 | Single server first, autonomous gateways in M4 | Defer distribution until the end-to-end path works | Real sites require unreliable-network autonomy before M4 |
| ADR-07 | Independent critical protections | Agreed in answer 24; web/Node/Linux are not safety controllers | A separate functional-safety scope and lifecycle are commissioned |
| ADR-08 | SVG HMI, React Flow graphs, own versioned project format | UI libraries do not define control semantics or the project format | Editor profiling demonstrates performance limits |
| ADR-09 | Protocol simulation first, firmware emulation later | Agreed in answer 23; covers failures and platform load earlier | Tests need specific firmware/peripheral behavior |
| ADR-10 | Full offline bundle and local package registry | Agreed in answer 36; recovery must not depend on external registries | Only an explicit change to the requirement |

## 3. Proposed defaults

These are design proposals subject to testing, not proven operational guarantees.

| Parameter | Proposal |
|---|---|
| Telemetry | On change plus a full snapshot every 1 s for the initial ESP32 |
| Logic | Event-driven; typical periodic jobs at 1 s; 100 ms only for a justified control loop |
| UI | 250 ms batches for subscribed data only |
| LED watchdog | 3 s without a valid session → OFF; new authorization after reconnect |
| History | Value and quality changes; checkpoint every 60 s |
| Aggregates | 1 min / 1 h for one year; time-weighted and quality-aware |
| Audit / alarms | One year by default; configurable independently of raw retention |
| Incident capture | 60 s before and 120 s after; retain 30 days; configurable per incident |
| Backups | Daily and before updates; 7 daily and 4 weekly copies on separate media |
| Disk thresholds | Warning at 70%, critical at 85%; reserve at least 10 GiB on the initial host |
| History budget | Initial 40 GiB quota on the 100 GB SSD; size before deployment |
| User session | Local authentication; HttpOnly/Secure cookie; duration to be refined through usability tests |

If seven days of history do not fit the allocated budget, the seven-day requirement is unmet. Report a capacity forecast; do not silently reduce retention while claiming compliance.

## 4. Open parameters

| Parameter | Needed by | Blocks the start of M0? |
|---|---|---|
| Open-source license | Before a licensed public release | No; the customer explicitly deferred it |
| Exact development board and LED GPIO | M1 HIL, through demo settings | No; selection was deferred |
| CPU model and measured SSD performance | Before interpreting load tests | No |
| Backup destination outside the working SSD | Operational acceptance | No; restoration can be tested on a temporary separate volume |
| SMTP/webhook endpoints and secrets | Deployment configuration | No |
| Physical Modbus/Zigbee/BLE devices and coordinator/radio | Hardware-verified status for each driver | No |
| Policies for a particular hazardous process | Before operating that process | Yes for its live control; no for the LED demo |
| Exact ST subset and additional boards | Before M5 | No |
| Production RPO/RTO and full-scale resource budget | Before operational promises and M4 | No |
| Team size and calendar deadlines | Execution planning | No; the specification does not invent calendar estimates |

No additional authorization is needed to prepare the specification. Deployment-specific open settings do not block independent implementation work; they must not become hidden assumptions when operating physical equipment.
