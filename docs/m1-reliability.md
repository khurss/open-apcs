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

The implemented extended **16-device / 16-output one-hour workload and resource gate passed** on clean revision `c286ba6` on 2026-10-14. All 57,600 commands were Verified and archived, with no missed generator ticks, 3600 UI and alarm transitions, UI p95/p99 362/437 ms, command acceptance p95 162.55 ms and no graph late/skipped starts. Peak summed container working set was 2.834 GiB and the final memory-window change was -1.58%. Source fingerprints matched before and after. See [the extended hour record](load-l0.md#extended-hour-pass-2026-10-14) for scope and artifacts.

Earlier failed runs remain preserved: a physical handshake timeout after 2588.876 seconds, a missed generator tick after 2113.928 seconds, and the short UI-latency failure. The subsequent transport and browser cadence corrections have reproducing tests; this successful hour does not identify a sole cause for every historical failure. Four physical fault modes passed the recorded 20 MHz logic-level profile in the prior recovery delivery. Continuous electrical and other unexecuted hardware cases remain outside this hour. The physical bench is stopped and the virtual demo is restored.

The source revision had already passed 620 unit/integration tests in 75 files, 14 Chromium scenarios and the full Docker gate before the hour. A post-hour documentation/regression check is recorded in the [TDD log](tdd-log.md). Full M1 remains partial because the boundaries below are not waived.

## Transport investigation

A subsequent [transport diagnostics increment](transport-diagnostics.md) adds owner-scoped bounded gateway traces, an opt-in firmware trace and a disarmed probe fixture. The original Unknown outcome and failed extended-hour result remain preserved. A [loaded latency investigation](transport-latency-fix.md) subsequently identified avoidable TCP buffering and a separate handshake deadline defect; its evidence must not be substituted for the failed extended-hour gate.

## Remaining release boundaries

- USB reset is not a power cut or brownout. Broker pause is not a Wi-Fi radio interruption. Those physical cases need a reviewed means of injecting the actual fault.
- An observed 3.72 V edge sample remains unqualified for edge integrity. Later captures explicitly use a recorded 20 MHz bandwidth and cannot invalidate that earlier failed observation.
- Rigol display captures have a gap between the fault trace and recovery window and 10 ms sample spacing. They do not establish continuous absence of shorter glitches.
- Existing simulated/native tests cover replay, duplication, expiry and session fencing. The physical workload does not exercise every malicious/late-message branch on real hardware.
- The measured 16-device, one-output-per-device profile is below the planned upper 200-signal L0 configuration and far below L1/L2.
- The timing graph reads physical feedback but does not write an output. Physical closed-loop PID, numeric I/O, OTA and additional boards/protocols have their own delivery and acceptance stages.
- Full M1 status remains tied to the implemented-scope acceptance matrix and the named unexecuted hardware/release cases. Passing this increment must not silently close them.

## Explicit physical recovery

The [reviewed LED recovery workflow](physical-recovery.md) adds a separate reconciliation receipt after a new controller boot, active reviewed GPIO commissioning and Good OFF feedback. It retains the old Unknown outcome and never replays an intent. The public API recovered the existing GPIO18 bench block and stopped control afterward. The subsequent [normal-firmware endurance attempt](load-l0.md#recovery-delivery-endurance-attempt-2026-10-14) stopped after 2113.928 seconds on a missed generator tick under high host CPU pressure. All 33,797 sent commands and archived changes were verified; there were no physical handshake timeouts. Those gates were still open at that point. The later extended hour passed its implemented profile as recorded above; the earlier failed result remains unchanged.
