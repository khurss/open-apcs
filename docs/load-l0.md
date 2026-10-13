# L0 LED workload and endurance evidence

## Workload

The opt-in L0 runner uses the reviewed GPIO18 ESP32 plus 15 virtual LED endpoints, one boolean output each, through the live authenticated HTTPS application and its durable MQTT command path. This is 16 active devices and 16 active signals, within the current runtime limit; it is not the upper 200-signal profile or a 10,000-device benchmark.

Each device alternates ON/OFF once per second on its own monotonic schedule. Deterministic phases are spaced 62.5 ms apart. There is no shared acknowledgement barrier between devices and no catch-up burst after a missed period. A 60-second warmup precedes the requested measurement. A full measurement lasts at least 3600 seconds and expects exactly 57,600 measured commands and archived changes. Setup, warmup and cleanup are excluded from those counts. A 60-second diagnostic run expects 960 measured commands and can only receive `smoke-passed`.

The workload includes one Chromium browser displaying the physical signal in the normal Signals panel. It does not activate a graph or generate alarm transitions. Protocol probes, lease renewals, acknowledgements, archive heartbeats and UI reads add traffic beyond the 16 commanded value changes per second.

## Execution

Use the existing private configuration and reviewed wiring from [the Rigol fixture](rigol-hil.md). All existing device runtimes must be stopped. Only the external GPIO18 LED is authorized by this profile. No source edits, hot-reload restarts, firmware updates or other operators may control the fixture during measurement.

```sh
export APCS_BENCH_PRIVATE=/absolute/path/to/private-rigol-config
export APCS_BENCH_ARTIFACTS=/absolute/path/to/shared-bench-artifacts

# Verify tooling first; this is not a one-hour pass.
APCS_L0_SECONDS=60 make load-l0

# Full workload, after a successful diagnostic run.
make load-l0
```

`APCS_L0_SECONDS` defaults to 3600 and is restricted to 60–3600. The host Python standard library only coordinates Docker and records host/container resources. Application requests, Chromium, timing checks, history validation and resource assessment execute in existing Docker images. Source and dependencies are mounted; no application image rebuild is required.

Stop the separate test Compose project before measurement if it still hosts active E2E simulators. Preserve its volumes and restore the required watchers afterward. The development API, web application, database and dedicated physical broker remain running. Do not run `make test` concurrently with performance measurement. Record other host workloads; resource samples contain the host load average.

The runner reuses the 15 virtual devices listed in the owner-controlled artifact file `l0-catalog.json`. On first use it creates a separate L0 project and writes that file before arming. On reuse it validates catalog identities, kinds and output bindings against the API. It never deletes projects, journals or historical evidence. API ownership checks still apply.

## Evidence and verdicts

Each workload directory stores target identities, accepted command IDs immediately in `requests.jsonl`, completed request/acknowledgement timings in `commands.jsonl`, browser value-change observations, complete per-signal history pages and a result. API responses are disposed after reading so the measurement client does not retain every response body for an hour.

The workload requires every measured request to become Verified and its current output to match the requested value with Good quality and the original boot. History must contain the complete ordered ON/OFF sequence for every target, with a consistent boot and nondecreasing source sequence; unchanged heartbeat observations may repeat. Archive drop, failure and observer-failure counters must not increase. A missed one-second period, clock divergence above 100 ms, runtime fault or incomplete history fails the workload. Normal termination and independent supervisor cleanup must also succeed.

`hour-workload-passed` denotes the implemented command/history workload only. It is not complete L0 or M1 release acceptance. The HTTP command acceptance p95 must also remain at or below 200 ms. Reports publish nearest-rank p50/p95/p99/max for HTTP command acceptance, request-to-Verified-and-current-state observation, and generator lateness. These include client/network overhead. Firmware acknowledgement is not independent electrical feedback.

The browser records physical ON/OFF text changes. The Signals panel reads batches of at most 100 signals, schedules its next refresh 250 ms after completion and aborts a refresh after three seconds. Slow responses may still coalesce intermediate values; this is reported separately from durable archive loss. Normalized MQTT-arrival-to-state latency and exact accepted-telemetry-to-paint latency are not measured by this runner. The 100 ms graph-task criterion, alarm workload and continuous electrical measurement also remain separate work.

Host evidence is linked through `runId` and includes source revision, dirty flag, a hash of non-Markdown authored files, image content IDs, CPU/kernel/Docker information, container placement/limits, and free filesystem space before/after. The disk difference includes other host activity and is not an isolated database-size measurement. Resource samples are collected about every 30 seconds for the development stack, physical broker/time service and workload container; no Docker socket is exposed inside the workload container.

For a full run the resource evaluator requires at least one hour of samples, consistent container membership, and no sampling gap above 90 seconds. Peak summed Docker working-set memory must stay at or below 12 GiB. Growth compares mean memory in the first five minutes of the final half-hour with the final five-minute mean and must not exceed 5%. Peak summed Docker CPU percentage and host load averages remain reported evidence, not invented CPU guarantees. Short runs preserve samples but cannot pass this resource gate.

## Cleanup

The fixture shares the instrument-directory lock with the Rigol tests. A separate supervisor records each created virtual target before its start request and the physical arming intent before commissioning. Worker cleanup stops all targets; supervisor cleanup independently attempts every recorded target even if one stop fails. A bounded timeout kills a blocked worker. Host interruption stops the named workload container so its supervisor can clean up. Final stopping removes control authority; the device's local lease supplies the fallback OFF behavior.

Complete host/container failure can prevent supervisor cleanup. Inspect the runtime and shared lock before another run. This fixture does not provide independent functional safety or permission to drive arbitrary actuators.

## Measured result: 2026-10-13

The corrected hour workload and its resource gate passed on the Linux x86-64 workstation with four CPUs and approximately 16 GiB RAM. The measured configuration was one physical GPIO18 ESP32 plus 15 virtual LEDs, one signal each, with the normal Chromium Signals monitor. This is a bounded L0 workload result, not full L0/M1 acceptance or the maximum 200-signal profile.

| Measurement | Result |
| --- | --- |
| Measurement duration, excluding warmup | 3600.941 s |
| Commands requested / Verified / archived changes | 57,600 / 57,600 / 57,600 |
| Missed periods / archive drops / archive errors | 0 / 0 / 0 |
| Browser physical transitions observed / sent | 3600 / 3600 |
| HTTP acceptance p50 / p95 / p99 / max | 36.8 / 111.9 / 169.0 / 516.6 ms |
| Request-to-Verified-and-current-state p50 / p95 / p99 / max | 234.5 / 458.6 / 575.2 / 1077.3 ms |
| Generator lateness p50 / p95 / p99 / max | 1.0 / 5.2 / 11.0 / 351.8 ms |
| Peak summed container working-set memory, including load client | 2.825 GiB |
| Memory growth across the defined final-half-hour windows | 3.207% |
| Resource samples / peak summed Docker CPU | 122 / 338.93% |

Both worker and independent supervisor confirmed stopped runtimes. The physical broker remained running. The measured source fingerprint stayed unchanged: `cee4566b82f11c9307721a18bf4dcf2e740498e32bf7fdb2bce3a0c84dd6b064`. Local workload evidence is `l0-2026-10-13T14-00-19.108Z`; its linked host run is `25c65514ef084cb8ac99d376b801f51b`. The deployed firmware and separate Rigol pulse evidence are recorded in the [TDD log](tdd-log.md).

Earlier diagnostics and the first hour attempt failed and remain preserved. They exposed generator scheduling defects, write-heavy receipt reads, browser request fanout, and periodic-only ESP32 telemetry. Fixes received reproducing tests before the successful run. Exact telemetry-to-state/UI latency, the 100 ms graph task, alarm workload, continuous electrical monitoring and remaining physical fault scenarios are still unqualified by this workload.
