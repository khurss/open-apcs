# Open APCS development phases

The customer selected small working deliveries: first an end-to-end ESP32 scenario with both editors and simulation, then broader logic, protocols, and scale. All target-specification features remain in scope; the first working milestone need not support 10,000 devices immediately.

No dates are assigned because team size and available time are unknown. Advancement depends on results rather than unsupported calendar estimates. After completing a phase, update the English documentation, run all applicable Docker checks, commit, and push to the project repository.

## M0: Foundation and container TDD

Scope: TypeScript monorepo, development/test Compose, offline dependency manifest, CI, signal/command/revision schemas, virtual clocks, initial simulator, PostgreSQL/MQTT, local authentication, migrations, and structured logs.

Exit: a new developer runs unit and integration tests in Docker without installing Node on the host; signal-quality, command-state-machine, and MQTT round-trip tests first fail, then pass. Schemas establish core types/APIs. A minimal project starts from a prepared offline bundle.

Current status: **foundation acceptance met for the Linux x86-64 engineering profile**. Docker TDD/watchers, signal/command/revision contracts, the virtual LED, the PostgreSQL journal, MQTT gateway/runtime libraries, local authentication, migrations, and structured startup logs are available. The minimal offline bundle was installed into a new workspace with empty dependency caches and passed the complete test suite. Database backup/restore is verified. Catalog-driven runtime commissioning and live graph activation belong to the next working-path deliveries; the ESP32 toolchain is now bundled; the complete production distribution remains future work. See the [distribution scope](distribution.md) and [TDD evidence](tdd-log.md).

## M1: Working ESP32 path

Scope:

- ESP-WROOM-32 with custom I/O firmware: GPIO/LED, Wi-Fi/MQTT, USB provisioning/recovery, watchdog, and acknowledgements.
- Device/signal catalog and diagnostics; virtual ESP32 using the same application contract.
- Basic HMI editor: labels, indicators, buttons, groups, bindings, persistence, undo/redo.
- Graph editor: input/output, conditions, debounce, timer, state, interlock, Auto/Manual.
- Simulation without physical outputs, traces, and connection-loss scenarios.
- Drafts and revisions, controlled per-graph publication, command/change journal, backups.
- Responsive English UI with two themes, basic history, and alarms.

Exit: AT-01–05, AT-07, AT-09–11, AT-14–18, and AT-20 for implemented scope; physical LED scenario, network failure, no replay after reconnect, and load profile L0. Complete coverage of the future block library is not claimed.

Current M1 status: **partially implemented**. Both basic editors, prepared revisions, boolean blocks, isolated virtual-time simulation, and web-controlled virtual LEDs running in a private worker are available. Prepared graph activation and controlled revision switching now run headlessly in that worker. The execution panel exposes timestamped active-revision calculation snapshots and historical/unavailable states; see [graph diagnostics](graph-diagnostics.md). Prepared HMI screens now show current signal values and use the common audited command path. A bounded raw history recorder and history browser are now available. Basic durable boolean/quality alarms, acknowledgement, and timed suppression are now available; passive monitoring starts with the server and recovers after worker death without rearming outputs; see [alarm operation](alarms.md). The ESP32 C protocol core and TLS firmware build are available for engineering tests; explicit TLS bench commissioning is now tested through the browser against a protocol simulator. A physical GOOUUU board has now been flashed and joined Wi-Fi/TLS. The initial GPIO5 onboard-LED trial did not visibly blink; a subsequent external GPIO18 LED completed 20 Verified browser commands and the owner confirmed visible blinking. A separate opt-in Rigol USB fixture now verifies the electrical ON/OFF pulse, lease expiry, silent broker loss/restoration and USB reset with bounded LOW observation windows; see [instrumented testing](rigol-hil.md). The device is disarmed after the test; see [the bench record](goouuu-bench.md). The 16-device L0 command/history workload passed a real hour with 57,600 Verified commands and archived changes, all 3600 physical UI transitions, and its memory gate; see [load qualification](load-l0.md). The subsequent [M1 reliability increment](m1-reliability.md) adds complete API-container crash/restoration evidence, fixes graph-period drift and instruments gateway, browser, graph and alarm timing. After preserved failed attempts and transport/browser corrections, the extended 16-output hour and resource gate passed on `c286ba6`: 57,600 Verified commands and archived changes, 3600 UI/alarm transitions, UI p95 362 ms, no missed ticks, and 2.834 GiB peak summed container memory. This does not establish a sole historical failure cause or complete the larger profiles and remaining hardware cases; see the load document. An [explicit physical LED recovery workflow](physical-recovery.md) now preserves Unknown outcomes while allowing reviewed new-boot/OFF reconciliation before a separate command; general actuator recovery remains outside this bench profile. Full HIL cases such as radio/power interruption and higher signal counts remain pending; annual aggregates and notification delivery belong to M2. Database backup/restore is now verified. See [editor contracts](editors.md).

## M2: Engineering release

Scope: JS/TS editor and isolated runner, formulas/filters/counters/PID, schedules, initial sequences and recipes, full versions/diff/rollback, OTA, ESPHome, faceplates, trends, pre/post-event incident capture, SMTP/webhooks, CSV/PDF and summaries, LED/tank/thermostat templates.

Exit: PID and Auto/Manual semantic tests, sandbox/fault suite, successful and failed OTA on the bench, ESPHome contract and hardware tests, exports/reports, backup/restore, and complete offline builds/updates/package installation. Verify the seven-day/one-year policy with virtual time and a bounded real dataset; measure disk capacity. Load profile L1.

Current M2 status: **partially implemented**. Structural comparison of prepared graph/HMI revisions and audited restoration into a new draft are available. Restoring a draft does not switch active control. This independent software increment proceeds while M1 physical acceptance is deferred; it does not complete M1 or M2. The initial JS/TS source editor and isolated boolean script runner are also implemented; see [script limits](script-runtime.md). A loaded-page raw trend and typed CSV export are also available. Durable local SMTP/webhook notifications and audited delivery logs are implemented; see [delivery contracts](notifications.md). Minute/hour aggregates, annual cleanup and a bounded backfill/recalculation worker are now available; see [history contracts](history-aggregates.md). Typed numeric constants/arithmetic/comparisons, hysteresis, elapsed-time filtering and bounded edge counters now execute through the graph editor and existing boolean output command path; a virtual thermal process now supplies live numeric inputs and a thermostat template, with a numeric HMI value widget. High/low threshold alarms now support hysteresis, activation/return delays and durable acknowledgement through the same notification pipeline. Normalized PID and windowed time proportioning are available through a device-selected thermal template; see [PID contracts](pid-control.md). Weekly schedule blocks now include named zones, explicit DST and downtime policies, clock-divergence faults and dated simulation; see [calendar contracts](weekly-schedules.md). Physical numeric drivers remain pending. See [numeric profile](numeric-logic.md). Initial single-output timed sequences with cancellation, start-edge gating, fault latching and editor step controls are available; see [sequence contracts](timed-sequences.md). Parameterized recipes and full SFC remain pending. Background daily/monthly single-signal PDF/CSV snapshots are available; see [report contracts](reports.md). Alarm/command and multi-signal reports, unit conversion, physical PID tuning, retentive/hardware counters, numeric/stateful scripts, physical numeric device drivers, counter profile configuration, capacity acceptance and the other M2 features remain pending.

## M3: Extended editors and integrations

Scope: FBD and SFC over the common model, extended recipes/libraries, HTTP device adapter, Serial, Modbus TCP/RTU, Zigbee2MQTT, BLE, driver/block/symbol SDKs, and local package installation. Independent adapters remain possible without core changes.

Exit: selected PR-02–08 pass the contract suite and physical-device tests, or accurately receive `Simulator-tested` status. Do not claim hardware verification for equipment absent from the bench. FBD/SFC pass documented semantic suites; do not claim full IEC 61131-3 compatibility without separate verification.

## M4: Scale and autonomous gateways

Scope: L2–L5 profiles, runtime/subscription partitioning, historian load tests and replacement if necessary, reconnect-storm control, offline gateway execution with a local journal, standalone gateway packages, diagnostics, and a sizing guide.

Exit: a verified profile of 10 sites / 10,000 devices / 50,000–100,000 signals on documented hardware with a specified change rate. If 4 CPUs / 16 GB / 100 GB is insufficient, publish measured limits and expansion requirements. Catalog size alone does not achieve the numeric target.

Loss of the central connection must not stop the published local task on an autonomous gateway. Central commands must not accumulate for later replay. Verify output ownership and protection against concurrent executors.

## M5: Ecosystem expansion

Scope: additional ESP32, Arduino/AVR, STM32/ARM, Mbed CE/existing mbed devices; local firmware execution in a CPU emulator; Structured Text; further industrial drivers; ARM64, roles/collaboration, and HA as needed.

Structured Text requires a separate ADR covering the supported syntax subset, types, loop/memory limits, timers, time semantics, compilation to the intermediate model, and FBD/SFC compatibility. A text editor without execution and tests is not ST support.

HA follows a single-writer/fencing model and split-brain testing. Safety-function certification is outside these phases and would require a separate development program.

## Dependencies

```mermaid
flowchart LR
  M0[Contracts and Docker TDD] --> M1[ESP32 and both editors]
  M1 --> M2[Engineering release]
  M2 --> M3[FBD SFC and protocols]
  M2 --> M4[Scale and gateways]
  M3 --> M5[Boards ST and ecosystem]
  M4 --> M5
```

Priorities between M3 and M4 depend on initial measurements and available equipment. Initial physical-device flashing, networking and visible external GPIO18 LED operation are verified; the remaining hardware and load gates are pending. Publishing the initial repository does not mark an unfinished implementation phase complete.

## Product usability and engineering expansion (requested 2026-10-13)

This delivery sequence adds to M1–M3; it does not waive their remaining physical or scale gates. Each delivery uses reproducing tests before behavior changes, Docker-only executable checks, a complete `make test` gate, English documentation, a reviewed commit and a push to the existing GitHub repository. Existing application data and physical provisioning are preserved.

| Delivery | Scope and exit criteria | Status |
| --- | --- | --- |
| P1 — Acceptance baseline and critical defects | Browser exploration of every existing section on desktop and mobile; maintain an acceptance matrix. Review project ownership and command boundaries. Reproduce and fix unauthorized reads/mutations and other confirmed critical defects. | Complete; see product acceptance |
| P2 — Project workspace and working demo | Clickable project navigation with a persistent selected-project context; project-specific devices, signals, logic and screens; search and useful empty states. An idempotent, audited demo installer creates virtual equipment, prepared logic and HMI screens. A clear start/stop workflow uses virtual devices only. Extend catalog editing with validation and optimistic concurrency. | Complete |
| P3 — Editor tools, trends and maintainability | Extract UI and API responsibilities into feature modules while preserving contracts. Add useful graph/screen editing actions, selection controls and reusable chart rendering. Provide live/history trend widgets with explicit unavailable quality. Demonstrate them in the installed demo. | Complete |
| P4 — AI-assisted draft authoring | Configurable external API first; local providers later. Server-side credentials, bounded requests, explicit disclosure of the project context sent, schema and binding validation, preview and deliberate draft application. Generated content never publishes or activates equipment automatically. Provider-independent contract tests run offline; a real-provider check requires configured credentials. | Complete for fixture-tested adapter; live provider check pending private configuration |
| P5 — Product README and final browser acceptance | Replace the implementation diary in README with product value, accurate capabilities, real screenshots, reproducible Docker startup/demo instructions and links to detailed docs. Use descriptive headings/image text and honest SCADA/HMI/ESP32 terminology; search ranking is not guaranteed. Repeat the acceptance matrix on desktop/mobile and both themes, inspect screenshots and console/network failures, fix confirmed defects, and publish the results. | Complete for implemented scope; see product acceptance |

The owner selected an external AI API before local-model support and confirmed GitHub as the publication target. Core operation and existing editors remain offline-capable; AI authoring is optional. The initial provider is OpenAI; its model and private credentials are configurable. No provider key is stored in Git or exposed to the browser.

Acceptance covers implemented user journeys: authentication, project creation/opening/editing, device registration/start/stop, signal inspection/manual control/history, graph construction/simulation/preparation/activation/revision changes, screen construction/operator view, alarms/acknowledgement/suppression, notification delivery inspection, CSV/PDF reports, audit, themes and responsive navigation. Hardware-only, external-service and unimplemented roadmap features receive explicit coverage labels rather than an invented pass. The defect review cannot establish the absence of every possible defect.

Load diagnostic follow-up (2026-10-14): receipt/signal HTTP timing is now
recorded separately, and shared worker cancellation no longer multiplies the
missed-tick counter. A short 16-output run verified and archived all 960 commands
but failed the unchanged UI latency criterion (p95 576 ms). Browser update-path
profiling and extended endurance remain open; see [load evidence](load-l0.md#short-profiling-result-2026-10-14).

Signal monitor follow-up (2026-10-14): removed the extra response-plus-250-ms
wait with a serial monotonic refresh schedule. The same short 16-output
profile now passes: 960 verified/archived commands, UI p95 491 ms and no missed
ticks. The UI margin is narrow; this is not a one-hour endurance or resource
qualification. See [cadence smoke evidence](load-l0.md#cadence-correction-smoke-evidence-2026-10-14).

Extended endurance follow-up (2026-10-14): the full 16-output hour and resource
gate now pass on `c286ba6`; [the result](load-l0.md#extended-hour-pass-2026-10-14)
closes this specific outstanding check while preserving all earlier failures
and the remaining M1 hardware/scale boundaries.

Multichannel simulation increment: [virtual input banks](input-bank.md) now
provide 1–15 numeric inputs plus a virtual LED, with web registration, real
MQTT telemetry, history, graph bindings and disconnect handling. The short
functional 200-signal test is distinct from full capacity qualification; the
16-active-device limit is unchanged. The mixed hour now passes command, history
and per-channel UI checks, and the owner accepted its 8.326% late-window memory growth under revised
policy v2 (10% growth, unchanged 12 GiB peak). The same samples pass the revised
evaluator; the historical 5% rejection is preserved. Retention investigation is
nonblocking backlog. This specific increment is accepted, without completing
remaining M1 hardware cases or larger capacity profiles.

The mixed 200-signal endurance runner and per-channel archive/UI criteria are
specified in [Mixed 200-signal qualification](load-200.md). Its qualification
status is recorded separately from the earlier 16-output hour pass.


Delivered M2 increment: numeric signal display settings in the catalog and live
monitor, with persisted units and decimal places, optimistic concurrency and
unchanged control values. See [signal presentation](signal-presentation.md).
The following display increment now applies those settings to HMI readings,
trends, history tables and aggregate values, including bounded metadata loading
and explicit failure/retry behavior. Version 2 CSV/PDF snapshots now capture configured units, precision and signal
revision at generation. Raw exported numbers remain unrounded, and legacy
artifacts retain their version 1 contracts; see [reports](reports.md).
