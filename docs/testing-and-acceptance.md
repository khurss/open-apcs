# TDD, testing, and acceptance criteria

TDD and Docker test execution are mandatory from the start. This document specifies required checks; it is not evidence that every planned application test has already run. Actual results are recorded in the [TDD log](tdd-log.md). Specification validation checks documents, links, and requirement consistency.

## 1. Workflow

For each behavior: select a requirement → write an observable-result test → run it in a container and observe the expected failure → implement the smallest solution → obtain a passing result → refactor and rerun the relevant checks.

PRs identify the requirement, scenario, initial-failure evidence, and final result. Test behavior rather than inventing a test for every line/component. Defect fixes start with a reproducing test. Generating tests only after completing implementation does not satisfy TDD.

Baseline rules:

- Core unit tests use fake clocks and fixed seeds, not networks, real clocks, or random delays.
- Protocol integration uses real PostgreSQL/MQTT and device simulators in Compose; mocked successful responses are insufficient.
- Production drivers and firmware share a contract suite with virtual devices.
- Timers, TTL, deduplication, quality, alarms, and output authority require property-based and fault tests.
- Proposed branch coverage for changed core packages is at least 85%; command/failure state machines must cover every listed transition and forbidden transition. Coverage does not replace property checks.
- Fix flaky tests; automatic retries must not conceal safety/command test failures.

## 2. Container environment

The target development interface provides the following commands. Unit, integration, browser E2E, networkless dependency checks, backup/restore, native firmware tests, and ESP32 cross-compilation services are implemented. Failure scenarios run in the unit/integration suites; separate contract/fault/load/HIL services remain planned. Do not treat an absent service as a completed test.

```bash
docker compose -f compose.test.yml run --rm unit
docker compose -f compose.test.yml run --rm contract
docker compose -f compose.test.yml run --rm integration
docker compose -f compose.test.yml run --rm e2e
docker compose -f compose.test.yml run --rm fault
docker compose -f compose.test.yml --profile load run --rm load
docker compose -f compose.test.yml --profile firmware run --rm firmware-test
docker compose -f compose.test.yml --profile hil run --rm hil
```

Services depend on readiness-checked fixtures and return nonzero on any failure. Independent runs must use unique Compose project names, volumes, and MQTT namespaces. The current persistent development watcher uses the isolated `open-apcs-test` project; journal tests additionally isolate database schemas. Tests must never connect to production endpoints or remove production volumes.

The offline bundle must include browser images, packages, certificates, seed data, firmware toolchains, and dependencies. Playwright supports container execution; its package version must match the browser image. See the [official Docker workflow](https://playwright.dev/docs/docker).

The test flasher/HIL receives only an explicitly specified USB port. HIL uses a separate profile, LEDs, and documented pin assignments. Ordinary unit/integration/E2E tests do not require a connected board. Without hardware, CI marks HIL as not executed; that is not a successful hardware check.

## 3. Requirements and acceptance matrix

| Test ID | Requirements | Verified result |
|---|---|---|
| AT-01 | FR-01, FR-02, FR-03 | Project/device/signal creation; validation of types, ranges, address conflicts, references |
| AT-02 | FR-03, FR-04, NFR-07 | Missing data is not zero; clock-based stale detection; late/out-of-order/duplicate data preserves current state; exact int64 |
| AT-03 | FR-05, FR-19 | GPIO assignment, incompatible-pin rejection, LED inversion, local watchdog without the server |
| AT-04 | FR-06–FR-10, UX-01–UX-04 | Create a screen, bind indicator/button, undo/redo, save/restore scene, display unknown quality |
| AT-05 | FR-11–FR-14 | Deterministic graph/timer/state execution; reject cycles without delays and ownership conflicts |
| AT-06 | FR-15, NFR-07 | Infinite scripts, excess memory/output, filesystem/network access cannot disrupt the main runtime |
| AT-07 | FR-16 | Change inputs, step/replay, obtain expected trace; simulation cannot write live outputs |
| AT-08 | FR-17 | DST/downtime does not repeat control events; recipes track partial failure without claiming atomicity |
| AT-09 | FR-18, FR-20 | External, graph, and Manual commands share interlock enforcement; correct idempotency and unknown outcomes |
| AT-10 | FR-19–FR-21 | Network/runtime/broker loss leads to the agreed state; old command/session is ineffective after reconnect |
| AT-11 | FR-22 | Alarm lifecycle, hysteresis, delays, ACK, return, suppression expiry, audit |
| AT-12 | FR-23–FR-25 | Value/quality changes, heartbeat, retention, time-weighted aggregates, counter reset, pre/post incident buffer |
| AT-13 | FR-26, NFR-09 | Failure diagnostics, disk limits, secret-free logs, queue metrics |
| AT-14 | FR-27 | Per-graph publication; invalid versions cannot activate; other graphs continue |
| AT-15 | FR-28 | Local session, unauthorized HTTP/WS/command rejection, actor audit, session protection |
| AT-16 | FR-29 | Export/import round trip, schema migration, broken references, malicious paths/assets, exclusion of secrets |
| AT-17 | FR-30, FR-33, NFR-02–NFR-03 | Installation, operation, editors, firmware builds, and package installation without external networking |
| AT-18 | NFR-01, NFR-04 | Closing all browsers does not stop logic; test scenarios are reproducible |
| AT-19 | NFR-05–NFR-07 | Agreed load profile passes with recorded latency, CPU, RAM, disk, backlog |
| AT-20 | FR-33, NFR-08 | Scheduled/pre-update backups; restore onto clean volume; revisions/audit/resources intact; no automatic physical outputs |
| AT-21 | PR-01–PR-08 | Each driver's connect/read/write/failure/reconnect, quality, acknowledgement limits |
| AT-22 | Firmware/OTA | Wrong chip/signature/digest rejected; interrupted OTA cannot cause an uncontrolled output; rollback verified |
| AT-23 | FR-13, FR-11 | PID saturation/anti-windup, Auto/Manual, FBD/SFC, and future ST pass separate semantic suites |
| AT-24 | FR-31, FR-32 | SMTP/webhook retries preserve event ID; at-least-once is not described as exactly-once; PDF/CSV/summaries preserve units, timezone, quality |
| AT-25 | FR-33 | Templates/local packages: manifest compatibility, dependencies, rollback, no execution on simple import |
| AT-26 | NFR-10 | Every phase requirement has a check and result; unexecuted hardware/load tests are explicit; requirement links remain valid |

## 4. First-release end-to-end scenario

1. On clean Linux x86-64 with Docker, load the prepared bundle, disconnect external internet, and start Compose.
2. Create an administrator, the `LED Demo` project, a site, a virtual ESP32, and signals `input.enable`, `output.led`, `device.online`.
3. Build input → debounce → condition → LED command logic, with a timer and bad-quality inhibition. Create an HMI with LED, button, Auto/Manual mode, and connection status.
4. Run Simulation, toggle the input, and check traces, current values, commands, and history.
5. Configure the physical ESP-WROOM-32, assign GPIO and active-high/low, build firmware in Docker, and flash the selected board through USB.
6. Verify Wi-Fi/MQTT connectivity. Publish the validated revision, perform commissioning, and enable LED control.
7. Turn on the LED. The UI shows `Requested`, followed by the firmware-confirmed state; independently verify the physical LED by observation/measurement.
8. Close the browser: execution continues. Stop the runtime or connection: the LED turns OFF after the agreed demo timeout.
9. Restore connectivity: the previous ON command is not replayed; a new authorized request is required.
10. Back up and restore onto a clean bench; verify matching configuration and absence of automatic command dispatch.

Virtual acceptance verifies GPIO behavior through the simulator. Steps 5–9 must run on physical hardware before claiming the first working hardware release.

## 5. Required failure scenarios

| Scenario | Invariant |
|---|---|
| Same command ID delivered twice | No repeated pulse or second operation |
| Command delayed beyond TTL | No execution on late delivery |
| Device accepted the command but ACK was lost | UI does not claim success; non-idempotent retry is prohibited |
| Device reboots and sequence restarts at zero | New boot ID separates new session from old messages |
| Heartbeat lost; retained broker state remains | Value cannot remain `Good` indefinitely |
| Two graphs claim the same output | Second activation rejected without explicit ownership transfer |
| Manual command with active interlock | Rejected with an explanation |
| Timer spans a system-clock change | Monotonic duration remains correct |
| Downtime around calendar event/DST | No unintended repeated action |
| Referenced signal/driver deleted | Publication blocked; active revision retained |
| Disk full / database failure | Explicit diagnostics; inability to audit is not concealed |
| Historian failure | Control loop does not wait indefinitely; buffer overflow is visible |
| Failure during partial publication | One graph cannot run two versions concurrently |
| Corrupt firmware/configuration package | Not applied; previous working version remains available |
| Expired local TLS certificate / unready clocks | Connection is not repaired by disabling certificate verification |
| 10,000 reconnects after network recovery | Backoff/jitter limits the storm; old queued commands are not restored |

## 6. Load profiles

Available initial host: 4 CPUs, 16 GB RAM, 100 GB SSD, x86-64. Reports record CPU model, kernel/Docker versions, available SSD space, container limits, and process placement. Before measurement, it is not a verified platform for 10,000 devices and a week of history.

| Profile | Devices / signals | Traffic and duration | Purpose |
|---|---|---|---|
| L0 | 1 physical + up to 20 virtual / up to 200 | 1 Hz, 1 h | End-to-end functional acceptance |
| L1 | 1,000 / 10,000 | One packet/device/s, 10% of signals change/s, 1 h | Initial bottlenecks on the available host |
| L2 | 10,000 / 100,000 | 10,000 packets/s, 10% changes, 1 h | Target online state and normal history profile |
| L3 | 10,000 / 100,000 | Every value changes/s; short bounded run first | Upper processing, storage, and backpressure limits |
| L4 | L2 + failure/reconnect | 10,000 devices reconnect with jitter, 30 min | Recovery and storm control |
| L5 | A previously sustained profile | 24 h, then 72 h soak with sufficient storage | Leaks, queue growth, retention, stability |

Proposed L2 logic workload: 1,000 graphs of 20 blocks on a 1 s cycle, a separate 100-block task at 100 ms, one browser subscribed to 500 signals, and 10 commands/s. This is a concrete initial benchmark, not an approved model for all future processes. Fix the graph profile before measuring.

Recommended criteria for L0 and then each agreed profile:

- Normalized gateway message arrival to available current state: p95 ≤ 100 ms, p99 ≤ 250 ms.
- Accepted telemetry to visible UI update: p95 ≤ 500 ms, p99 ≤ 1 s; age before reception is measured separately.
- For a 100 ms task: p99 start delay ≤ 50 ms on the selected host; exceeding this means the profile is unsuitable for that process.
- Command API acceptance p95 ≤ 200 ms; physical response time is measured separately and depends on the device.
- After warmup, total container memory ≤ 12 GiB on the 16 GB host; memory growth over the last 30 minutes of a bounded run ≤ 5%, with no unbounded backlog.
- No acknowledged command/alarm loss in the normal profile; verify telemetry persistence by sequence and count. Check UI coalescing separately from history.

Overload must cause diagnosed throttling rather than false `Good` quality. Do not run L3 before calculating disk budgets and limits: the 100 GB SSD is not intended to store every one of 100,000 values/s for multiple days.

## 7. Reports and Definition of Done

A phase is complete only after its criteria pass and results are published: commit/revision, image digests, seed, host, configuration, duration, latency percentiles, throughput, peak memory, disk growth, losses, and limitations. Update English specifications, run the complete applicable Docker suite, and commit/push each completed phase.

Required artifacts: JUnit/coverage, contract reports, browser traces on failure, load metrics, firmware manifests, HIL records, updated documentation, and known limitations. Storage schema changes include upgrade/rollback-or-restore verification; dependency changes run the relevant contract suite.

Not complete: an attractive UI without a working runtime; mock-only integration; a simulator labeled as hardware verification; unexecuted tests; 10,000 catalog entries instead of active devices; a short benchmark instead of proven week-long history capacity.
