# Transport timing diagnostics

This engineering increment adds correlated evidence for the unresolved physical session timeout recorded in [M1 reliability qualification](m1-reliability.md). It does not extend deadlines, retry an output command, reconcile Unknown outcomes or rearm control automatically.

## Gateway evidence

An authenticated project owner can request `GET /api/v1/devices/{id}/runtime?trace=true`. The optional `transport` field contains a volatile window of at most 128 events and an `overwritten` count. Normal runtime requests omit this field, avoiding large diagnostic responses in routine interface polling. Before the first runtime start it is null. Stop preserves evidence; replacing the worker or creating a new runtime entry loses it, so export before rearming.

Each event records a sequence number, host wall timestamp, host monotonic milliseconds, a fixed event name, packet length and a 32-bit FNV-1a fingerprint. Events cover send, broker publication acknowledgement, receive, handshake timeout and disconnect. A timeout carries the fingerprint of the unanswered request. A broker PUBACK confirms broker receipt only, not delivery to the ESP32, GPIO application or command verification. No raw payload, credentials, arbitrary error string or source code is stored in this window. Existing authentication and project ownership checks apply through the API and private worker IPC.

Fingerprints are non-cryptographic correlation aids. Match direction, byte length, order and MQTT message IDs where available. A fingerprint is neither a unique identity nor an integrity/authentication check. Rejected receive frames may appear in transport evidence without becoming accepted signal samples.

## Firmware evidence

`CONFIG_APCS_DIAGNOSTIC_TRACE` defaults to disabled. The optional diagnostic build timestamps MQTT receive, control processing, entry/return of response enqueue, publication acknowledgement and disconnect. A bounded 64-entry queue feeds a separate low-priority USB printing task. Producers never wait for diagnostic queue space; dropped events and event sequence numbers expose incomplete evidence. No protocol fields, lease durations, GPIO configuration or reconnection policy change.

The manufacturer documents internal locking in the MQTT API; enqueueing a response does not prove that it has already reached the wire. See [ESP-MQTT API documentation](https://docs.espressif.com/projects/esp-idf/en/v5.5/esp32c2/api-reference/protocols/mqtt.html). This is a possible delay mechanism, not proof of the cause of the earlier hour-test failure.

Build the diagnostic application in the existing pinned Docker toolchain, with a separate build directory and SDK configuration:

```sh
docker compose -f compose.test.yml run --rm firmware-build idf.py \
  -B /workspace/.cache/firmware-trace-build \
  -DSDKCONFIG=/workspace/.cache/firmware-trace-sdkconfig \
  '-DSDKCONFIG_DEFAULTS=/workspace/firmware/esp32-led/sdkconfig.defaults;/workspace/firmware/esp32-led/sdkconfig.trace' build
```

Confirm the selected board, explicitly stopped runtime, matching partition table and application size before flashing. Write only the reviewed application partition using the pinned ESP-IDF Docker tool; do not erase or rewrite provisioning. Restore the normal diagnostic-disabled application after investigation. A diagnostic build has different timing overhead and is not a production endurance qualification.

## Disarmed probe fixture

`compose.trace.yml` is opt-in and never runs from ordinary development or `make test`. It mounts the existing private HTTPS credentials and only the selected physical MQTT connection file. It connects to the explicitly selected broker network without a Docker socket or USB access. The runner requires exactly one GPIO18 allowlist entry and checks the physical runtime remains stopped before each probe.

The fixture sends only `probe` frames, never leases or writes. Every matched reply must report OFF and retain the same boot identity. Probes use unique nonces, QoS 1, no retained publication and a one-second message expiry. The 1500 ms diagnostic observation window allows late replies to be measured; it does not change the application's 250 ms snapshot freshness or 500 ms handshake deadline. Results count replies exceeding 250 ms, missing replies and any unexpected state. Missing/late observations are diagnostic findings, not permission to retry an actuator command.

```sh
export APCS_BENCH_PRIVATE=/absolute/private/rigol-config-directory
export APCS_BENCH_ARTIFACTS=/absolute/private/artifact-directory
export APCS_PHYSICAL_FILE=/absolute/private/physical.json
export APCS_BENCH_NETWORK=open-apcs-dev_frontend
APCS_TRACE_SECONDS=300 docker compose -f compose.trace.yml run --rm probe
```

The probe runner shares `rigol.lock` with the other physical fixtures. Do not run it concurrently with another controller or bench operation. Normal shutdown releases the lock; after a hard process/host failure inspect the physical state before removing a stale lock. No control lease is granted by this fixture.

Run `tests/hil/serial-trace.py` in the pinned ESP-IDF Docker image with only the selected serial device mapped to `/dev/bench-serial`, an artifact-directory mount, `APCS_TRACE_OUTPUT` and a bounded `APCS_TRACE_SECONDS`. The collector persists only diagnostic JSON records, not raw boot logs or credentials. It makes no explicit reset request, but opening a USB serial adapter can toggle control lines and reset this board. **Wait for `APCS_TRACE_DATA_READY` before starting network probes.** A changed boot during the measurement invalidates the run. The USB host read timestamp includes buffering; use device timestamps for firmware-stage durations.

Optional broker debug logging can correlate MQTT packet IDs with the probe client's and device's publications. Save its prior private configuration, use a reviewed reload, preserve timestamped logs locally, and restore the original configuration afterward. Debug log timestamps reflect logging, not an independent wire measurement.

## Evidence interpretation

The probe directory contains network event JSONL and a result with request/reply/missing/late counts and nearest-rank RTT percentiles. The USB collector records device events with host receipt timestamps. Run `tests/hil/report-transport.ts /artifacts/<capture>.jsonl` in the existing Docker tools to summarize firmware stage durations.

Ingress delay pairs receive with control processing; enqueue delay pairs entry with return. ACK time is measured from enqueue entry, because a broker acknowledgement can arrive before enqueue returns. The analyzer handles this concurrency and exposes gaps, dropped records and unmatched stages instead of claiming complete evidence. All firmware duration calculations use the same device monotonic clock. Cross-host/device timestamps cannot simply be subtracted without a clock mapping. A complete diagnostic record still does not establish electrical output timing, radio loss, production load performance or the cause of an earlier uninstrumented failure.

## Supervised OFF session renewals

The optional `session` service uses the normal authenticated commissioning API to establish and renew the GPIO18 session for 10–3600 seconds. Unlike the disarmed probe fixture, this grants a temporary control lease. It submits **no output commands**, requires stable Good/OFF feedback from one boot, and exports the gateway trace incrementally with sequence-gap checks. A runtime fault immediately fails the diagnostic. An independent parent process records arming intent and disarms on success, error, interruption or worker death. The shared fixture lock is released by that parent.

```sh
# Same private HTTPS/artifact variables as above. Start USB collection first.
APCS_TRACE_SECONDS=600 docker compose -f compose.trace.yml run --rm session
```

This does not reconcile or erase earlier Unknown commands. It measures ordinary lease renewal with an OFF output, not the 16-device command/graph/alarm workload. Stop the serial collector after the worker and independent supervisor confirm stopped authority. Never flash/reset the board while this fixture is running.

## Recorded probe result, 2026-10-14

The first probe attempt (`transport-2026-10-14T07-50-05.795Z`) was invalidated by a board reboot during serial-reader startup: six requests, one matched reply, four missing replies, then rejection of the changed boot. It is not accepted as network latency evidence. The collector must signal data readiness before network measurement begins.

The corrected 300-second diagnostic (`transport-2026-10-14T07-51-45.019Z`) completed 574 probes and matched OFF replies with one stable boot: zero missing, zero above 250 ms, RTT p50 65.98 ms / p95 76.56 ms / p99 89.44 ms / maximum 110.11 ms. It sent no leases or output commands.

The associated USB record (`transport-device-2026-10-14-2.jsonl`) contains 3902 events, with zero sequence gaps, drops or unmatched stages. Device-clock ingress delay was p95 9.705 ms / maximum 14.110 ms; enqueue duration p95 1.057 ms / maximum 6.186 ms; broker ACK from enqueue entry p95 64.429 ms / maximum 101.499 ms. There are 574 ingress pairs and 918 transmit/ACK pairs, including periodic OFF telemetry. This capture did not reproduce a long enqueue block or identify the cause of the previous uninstrumented hour failure.

The subsequent 600-second supervised renewal run (`session-2026-10-14T07-57-47.029Z`) completed 575 stable Good/OFF observations. Its complete gateway export contains 3576 events: 992 sends, 992 broker PUBACKs, 1590 receives, zero handshake timeouts and two disconnect events during cleanup. Every send has a corresponding PUBACK; host-monotonic publication acknowledgement latency was p95 46.23 ms / p99 48.21 ms / maximum 50.54 ms. Worker and independent supervisor both confirmed stopped authority.

The associated firmware capture has 7042 events without gaps, drops or unmatched stages. It contains 992 ingress pairs and 1686 transmit/ACK pairs, including OFF telemetry outside the exact renewal interval. Maximum ingress delay was 14.012 ms; maximum enqueue duration 6.926 ms; broker ACK from enqueue entry p95 65.242 ms / maximum 121.349 ms. No long enqueue stall was reproduced. Broker logs, firmware fingerprints and gateway/device captures remain in the ignored local artifact directory. Debug broker logging was restored afterward.

**The earlier extended-hour failure remains unresolved.** These are unloaded diagnostics using an instrumented build, not the previous 16-device graph/alarm/command workload. They provide a tested means to capture the next failure; they do not establish that it was caused by Wi-Fi, firmware locking or host scheduling. Preserve the failed command and all original deadlines when resuming full-load investigation.

After investigation, the normal application was rebuilt with `CONFIG_APCS_DIAGNOSTIC_TRACE` disabled and flashed to the same application partition with hash verification. The 10-second restoration check (`session-2026-10-14T08-14-29.757Z`) observed ten Good/OFF samples and 67 gateway events, then both cleanup layers confirmed stopped control. This is a restoration smoke check, not endurance evidence.


The complete Docker regression passed 607 unit/integration tests, 13 browser scenarios, 442 native firmware checks and nine orchestration checks, plus cross-build, renderer recovery, TypeScript/language checks, offline build and backup/restore. Final authenticated inspection confirmed the old physical command remains Unknown and unreconciled. Physical control and all L0 targets are stopped; the prepared virtual Climate PID demo and source/test watchers are restored.
