# M1 reliability qualification

This increment closes specific gaps in the existing GPIO18 engineering bench. It does not expand actuator permissions, claim hard real-time control or certify functional safety.

## Delivery and evidence

| Work | Acceptance evidence |
| --- | --- |
| Complete API process/container loss | Dedicated `server-loss` Rigol capture, bounded fault-to-LOW interval, restart/readiness, subsequent LOW window, stopped authority and independent cleanup |
| Existing fault regression | Repeat lease expiry, dedicated physical broker pause/restoration and USB device reset on the final source |
| Correct 100 ms scheduling | Fake-clock RED/ GREEN regression with nonzero evaluation cost, no overlapping/catch-up work, skipped-slot diagnostics and pause/resume semantics |
| Gateway timing | Real MQTT/PostgreSQL accepted-frame and duplicate checks; bounded histogram of callback-to-current-state latency |
| Browser timing | Same-host Chromium rendering-opportunity timestamps correlated with archived physical transitions, quality and order checked |
| Logic/alarm workload | Prepared read-only 100-block task, 100 ms period, persisted alternating physical LED alarm transitions |
| Regression and distribution | Docker `make test`, existing images, mounted source, native firmware checks and ESP32 cross-build, offline dependency build and database restore |

See [TDD record](tdd-log.md), [physical evidence and wiring](rigol-hil.md), and [L0 workload/evidence](load-l0.md) for results and limitations. Raw measurement artifacts remain local under the ignored `.cache/hil` directory; they are not a public secret/configuration distribution.

## Current verdict

The scheduling and MQTT receive-path corrections, bounded diagnostics, server-crash fixture and supplemental qualification tooling are implemented. Four physical fault modes passed the explicitly recorded 20 MHz logic-level measurement profile. The extended short diagnostic passed; **the extended one-hour release gate failed** on a physical session-handshake timeout after 2588.876 seconds and remains open. The earlier base-workload hour is not evidence for this extended profile. See [load evidence](load-l0.md#extended-qualification-outcome-2026-10-13) for the exact failure and required follow-up.

Final Docker regression passed: 601 unit/integration tests, 13 Chromium scenarios, 435 native C checks, nine orchestration checks, ESP32 cross-build, renderer recovery, TypeScript/language checks, offline build and backup/restore. The LAN virtual demo is running again; the physical bench remains stopped. The full regression result does not override the failed hardware endurance gate.

## Remaining release boundaries

- USB reset is not a power cut or brownout. Broker pause is not a Wi-Fi radio interruption. Those physical cases need a reviewed means of injecting the actual fault.
- An observed 3.72 V edge sample remains unqualified for edge integrity. Later captures explicitly use a recorded 20 MHz bandwidth and cannot invalidate that earlier failed observation.
- Rigol display captures have a gap between the fault trace and recovery window and 10 ms sample spacing. They do not establish continuous absence of shorter glitches.
- Existing simulated/native tests cover replay, duplication, expiry and session fencing. The physical workload does not exercise every malicious/late-message branch on real hardware.
- The measured 16-device, one-output-per-device profile is below the planned upper 200-signal L0 configuration and far below L1/L2.
- The timing graph reads physical feedback but does not write an output. Physical closed-loop PID, numeric I/O, OTA and additional boards/protocols have their own delivery and acceptance stages.
- Full M1 status remains tied to the implemented-scope acceptance matrix and the named unexecuted hardware/release cases. Passing this increment must not silently close them.
