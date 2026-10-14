# L0 LED workload and endurance evidence

Latest verdict: the [extended hour on 2026-10-14](#extended-hour-pass-2026-10-14) passed the implemented 16-output workload, supplemental checks and resource gate. Historical failed runs remain recorded below. Full M1 and larger-scale acceptance remain incomplete.

## Workload

The opt-in L0 runner uses the reviewed GPIO18 ESP32 plus 15 virtual LED endpoints, one boolean output each, through the live authenticated HTTPS application and its durable MQTT command path. This is 16 active devices and 16 active signals, within the current runtime limit; it is not the upper 200-signal profile or a 10,000-device benchmark.

Each device alternates ON/OFF once per second on its own monotonic schedule. Deterministic phases are spaced 62.5 ms apart. There is no shared acknowledgement barrier between devices and no catch-up burst after a missed period. A 60-second warmup precedes the requested measurement. A full measurement lasts at least 3600 seconds and expects exactly 57,600 measured commands and archived changes. Setup, warmup and cleanup are excluded from those counts. A 60-second diagnostic run expects 960 measured commands and can only receive `smoke-passed`.

The workload includes one Chromium browser displaying the physical signal in the normal Signals panel. The extended fixture also activates the read-only graph and alarm workload described below. Historical results in this document predate that extension. Protocol probes, lease renewals, acknowledgements, archive heartbeats and UI reads add traffic beyond the 16 commanded value changes per second.

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

The browser records physical ON/OFF text changes. The Signals panel reads batches of at most 100 signals, schedules serial refreshes on a monotonic 250 ms grid, skipping elapsed slots and aborts a refresh after three seconds. Slow responses may still coalesce intermediate values; this is reported separately from durable archive loss. Normalized MQTT-arrival-to-state latency and exact accepted-telemetry-to-paint latency are not measured by this runner. The supplemental qualification below adds graph, alarm and browser rendering-opportunity measurements. Continuous electrical measurement remains separate work.

Host evidence is linked through `runId` and includes source revision, dirty flag, a hash of non-Markdown authored files, image content IDs, CPU/kernel/Docker information, container placement/limits, and free filesystem space before/after. The disk difference includes other host activity and is not an isolated database-size measurement. Resource samples are collected about every 30 seconds for the development stack, physical broker/time service and workload container; no Docker socket is exposed inside the workload container.

For a full run the resource evaluator requires at least one hour of samples, consistent container membership, and no sampling gap above 90 seconds. Peak summed Docker working-set memory must stay at or below 12 GiB. Growth compares mean memory in the first five minutes of the final half-hour with the final five-minute mean and must not exceed 5%. Peak summed Docker CPU percentage and host load averages remain reported evidence, not invented CPU guarantees. Short runs preserve samples but cannot pass this resource gate.

## Cleanup

The fixture shares the instrument-directory lock with the Rigol tests. A separate supervisor records each created virtual target before its start request and the physical arming intent before commissioning. Worker cleanup stops all targets; supervisor cleanup independently attempts every recorded target even if one stop fails. A bounded timeout kills a blocked worker. Host interruption stops the named workload container so its supervisor can clean up. Final stopping removes control authority; the device's local lease supplies the fallback OFF behavior.

Complete host/container failure can prevent supervisor cleanup. Inspect the runtime and shared lock before another run. This fixture does not provide independent functional safety or permission to drive arbitrary actuators.

## Historical base workload result: 2026-10-13

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

## Supplemental telemetry, graph and alarm qualification

The extended runner adds a prepared **read-only 100-block graph** (the physical input followed by 99 NOT blocks) on a 100 ms monotonic grid. It does not acquire output ownership, so the existing independent 1 Hz command workload remains unchanged. A low-priority boolean alarm observes the same physical output; no alarm ACK is sent during measurement. The runner requires every alternating activation/reactivation/return to be persisted in order within the unacknowledged occurrence. It preserves all inspected events. This is one alarm rule, not the maximum alarm capacity.

Gateway diagnostics count accepted telemetry frames and summarize the interval from the MQTT message callback, before decoding, through accepted current-state ingestion and synchronous observers. Rejected/duplicate frames and session handshakes are excluded. This captures local receive handling and synchronous observers, but not device-to-broker transit. ACK persistence has its own bounded queue and no longer blocks current-state or handshake processing. A bounded histogram uses 1 ms upper-bound buckets through 1024 ms and the observed maximum for its overflow bucket. The runner requires p95 at or below 100 ms and p99 at or below 250 ms; maxima are also reported. The gateway does not retain an unbounded sample list.

Graph status exposes bounded lifetime start/execution/skip counters. The runner requires start-delay p99 at or below 50 ms and the expected scheduled-slot count over warmup plus measurement. Skipped slots count as over-budget starts: late starts over 50 ms plus skipped slots must remain within 1% of scheduled slots, so dropping slow work cannot falsely improve acceptance. At least 99% of the expected starts must execute. Maxima, execution time and every skip remain visible; this is a percentile criterion, not a guarantee that all cycles meet 50 ms. A read-only graph does not establish physical closed-loop PID performance.

For the physical signal, ordered browser value changes are paired with the first archived accepted sample for each transition. Browser timestamps are captured after two animation-frame callbacks following DOM mutation, allowing a rendering opportunity. The containerized browser and server share the same host wall clock. This is an observed rendering-opportunity latency, not optical display timing; missing/reordered transitions, negative clock deltas, bad quality or p95 above 500 ms / p99 above 1 s fail qualification. Heartbeat-only refreshes do not reset the transition timestamp.

The added artifacts are `qualification-targets.json`, `physical-changes.json`, `alarm-events.json`, `timing.json` and `qualification.json`. Graph identity is sent to the independent supervisor before activation; worker and supervisor both stop it. Each invocation preserves its prepared graph for inspection. The named alarm is reused only after its signal, condition and suppression configuration match. The extended workload remains a bounded 16-device engineering fixture and does not qualify 200 signals, 10,000 devices, continuous electrical acquisition, radio loss, brownouts or all M1 release requirements.

On failed runs, an explicitly stopped graph may retain its historical `faulted` state; cleanup accepts that inactive state for graph paths only. Every device still must confirm `stopped`. This distinction does not turn a failed measurement into a pass.

The load client polls durable command results/current state within a separate 2000 ms observation budget. A delayed stale HTTP response can require another read even after the command has already been Verified. This polling does not reissue a command or extend its 1000 ms TTL. Per-request HTTP timeouts still bound individual reads; the monotonic 1 Hz cadence independently rejects a missed period. Application API/telemetry/UI latency thresholds remain unchanged. Observation time is reported separately from the durable command timeline.


## Extended qualification outcome: 2026-10-13

**The extended one-hour gate is not passed.** The earlier base-workload result above remains historical evidence for its recorded source/profile; it does not qualify the additional graph/alarm workload or the current transport revision.

The final 60-second diagnostic (`l0-2026-10-13T20-34-34.968Z`) passed 960 requested/Verified/archived changes and 60 ordered browser/alarm transitions. UI rendering-opportunity latency was p95 495 ms / p99 580 ms. The read-only graph recorded 1267 starts, p99 start delay 9 ms, maximum 14.318 ms and no skipped or over-50-ms starts. Maximum accepted gateway receive handling was 4.596 ms. This remains a smoke result.

The subsequent extended attempt (`l0-2026-10-13T20-36-53.062Z`, host run `7dfd122e7afa4576b999cca1fda8773f`) failed after **2588.876 seconds**: 41,407 requests, 41,406 observed Verified commands and one physical command with an unknown outcome. There were no generator missed periods; archive error/drop counters remained zero through the last progress sample. Final complete-history, UI/alarm and resource qualification was not reached. The result's zero `historyChanges` means that final validation did not execute, not that no history was written.

The durable physical command timeline is Accepted at `21:21:08.112Z`, Dispatched at `21:21:08.274Z`, and Unknown at `21:21:09.061Z`, with reason `Connection lost; physical outcome unknown`. The preserved physical runtime category is `handshake timeout`. This establishes failure to receive the required correlated session reply within the existing deadline; it does not identify whether the underlying delay originated in radio transport, firmware, broker delivery or host scheduling. No electrical trace was recorded continuously during this workload, so physical application of that final command cannot be asserted.

All 16 device runtimes were inspected as stopped after independent cleanup. The 15 virtual runtimes had no runtime error; the physical runtime retained the handshake-timeout diagnostic. The transmitted command was not retried and no automatic rearming or deadline relaxation was introduced. Source fingerprint `16b6cd4e7aa2fcff90762d9d8d9ee9333335b9cc402d441fb104b34642ccfd9b` remained unchanged throughout the attempt.

Next qualification work must capture correlated probe/confirmation timing across the gateway, broker and ESP32 to isolate the physical timeout, then rerun the unchanged one-hour acceptance criteria after any justified correction. Repeating runs until one happens to pass would not resolve this recorded reliability gap. See the TDD log for the earlier reproduced queue and observer defects and their independent fixes.


## Recovery delivery endurance attempt: 2026-10-14

The next extended-hour attempt on recovery revision `02ea89d` **failed as a workload measurement** after 2113.928 seconds (about 35.2 minutes). It is not an hour pass. Artifact `l0-2026-10-14T10-26-47.290Z`, host run `df1cacf41de1433ea21b4f7e3b1a980d`, used the normal diagnostic-disabled firmware, the unchanged 16-output / 1 Hz profile, the 100-block read-only task, physical transition alarm, Chromium and archive. Test dependency services were stopped. Extra read-only gateway/TCP collectors ran alongside the workload; no USB collector or diagnostic firmware was used.

The runner stopped with `Load generator missed tick 2112 by 1559 ms`. Every one of its 33,797 sent commands had been observed Verified. An independent postmortem history read subsequently verified all 33,797 ordered changes against their expected boot/quality/sequence and per-device request counts. The original result remains failed with `historyChanges: 0`, because its own final qualification never ran; postmortem integrity is separate evidence, not a rewritten pass. The result's `missedTicks: 16` includes propagation of the first shared failure through the other cadence workers; it is not evidence of 16 independently measured deadline misses.

No physical handshake timeout or session loss was observed. The complete gateway export contains 21,120 events with zero sequence gaps/read errors and 5978 matched broker acknowledgements; p95 PUBACK callback latency was 8.22 ms, maximum 38.84 ms. This measures broker acknowledgement, not device actuation latency. No firmware-stage timing is available in this normal build. Source fingerprint `bd137c33c07025a0332be02d5628751ef39cccf3efad267bf3a1bd6b713d6277` matched before and after the run.

At failure, the host CPU was almost fully occupied and CPU pressure `some avg10` was approximately 66–71%. Last pre-stop resource samples had a 1-minute load average near 13 on four CPUs. For the first cadence worker's last command, the durable journal recorded Verified 378 ms after the client's send timestamp, but the client finished observing it after 1822 ms. Other inspected slow observations were 1689–1955 ms while durable verification took 539–628 ms. These observations support investigating host contention and the HTTP observation/generation path; they do not isolate a sole process or establish that every application latency target passed. No lease, TTL, sampling cadence or acceptance threshold was relaxed.

The stopped graph retained 21,773 starts, p99 start delay 9 ms, maximum 53.31 ms, one over-50-ms start, no skipped slots and maximum evaluation 43.53 ms. All 16 load runtimes and the observer graph stopped; worker and independent supervisor cleanup succeeded. The normal virtual Climate PID demo was restored afterward. One-hour resource, complete UI/alarm and extended release qualification remain open.

The next performance increment should profile generator/HTTP observation scheduling and development-watch overhead on this four-core host, then validate a justified correction or an explicitly documented deployment profile against the same one-hour criteria. Merely increasing deadlines, suppressing missed ticks or retrying until a pass is not an accepted resolution. The earlier 43-minute physical timeout remains historical evidence; this shorter run did not reproduce it or prove its sole cause.

## Observation profiling and missed-tick accounting

Each completed command in `commands.jsonl` includes `receiptObservation` and
`signalObservation`: HTTP check count, total/max check duration, actual polling
wait duration, and elapsed observation time. These client-side durations include
network, server and scheduler delays; they do not isolate database or device time.
Failed/incomplete observations still fail the run and are not included in these
completed-command samples. No extra HTTP reads are introduced.

`missed-ticks.jsonl` records actual cadence deadline violations with signal ID,
tick, measured/warmup flag, timestamp and lateness. Cancellation propagated from
another worker does not increment `missedTicks`. Earlier reports could count the
same shared error once per worker; those historical artifacts remain unchanged.
The 1 Hz schedule, missed-period rejection, command TTL, handshake and observation
budgets, and acceptance thresholds are unchanged.

### Short profiling result (2026-10-14)

Private artifacts: `l0-2026-10-14T11-47-56.426Z` and host run
`139244dada114f3d8fa938a8fe8dd94c`. After 60 seconds of warmup,
all 960 measured commands were Verified and all 960 changes were archived;
there were zero missed ticks. Acceptance p95 was 185.23 ms and full
verification/observation p95 was 603.21 ms. Receipt observation p95 was
368.31 ms (HTTP checks 242.05 ms, polling waits 134.66 ms); signal observation
p95 was 124.24 ms, with one read per command. These are separate percentile
distributions and must not be added to estimate an overall percentile.

**The run failed UI latency acceptance:** all 60 physical transitions were
observed, but UI p95 was 576 ms against the unchanged 500 ms limit
(p99/max 630 ms). The earlier missed-tick failure did not recur in this short
window. Neither the CPU-contention cause nor one-hour endurance is resolved.
Next: profile the browser signal update path and server/client scheduling under
the same workload before attempting the extended release gate. The physical and
load runtimes stopped; the virtual Climate demo was restored using audited
virtual recovery for an in-flight command interrupted during demo shutdown.

## Signal monitor cadence correction

The Signals page now schedules serial refreshes on a monotonic 250 ms grid.
Response time is included in that interval instead of adding a further 250 ms
after every response. Slow rounds skip elapsed slots and never overlap or
replay missed requests. All batches still complete before a page snapshot is
published, errors disable control, and navigation aborts pending reads. This
can increase request frequency compared with the slower previous loop, but
retains a single in-flight round and a maximum nominal four rounds per second.
It does not change command, telemetry, safety or acceptance timing thresholds.

### Cadence correction smoke evidence (2026-10-14)

Private artifacts: `l0-2026-10-14T12-06-44.414Z`; host run
`1902653bea064743b6fc34f0ba2bf03c`. The normal-firmware 16-output profile
completed 60 seconds of warmup and 60.938 seconds of measurement:
960 commands, 960 Verified observations, 960 archived changes, zero missed
ticks, all 60 UI transitions and 60 alarm transitions. Command acceptance
p95 was 184.72 ms. UI latency p95 was **491 ms**, p99/max **538 ms**, against
unchanged 500/1000 ms criteria. The graph recorded 1268 starts, zero late or
skipped starts and p99 start delay 8 ms. The workload and independent
supervisor both stopped control.

This is a **smoke pass**, not extended endurance acceptance. The preceding
short run measured UI p95 576 ms; these runs were sequential on a shared host
and are not a controlled attribution of every millisecond. Unit tests establish
the removed response-plus-delay behavior. The observed margin to the UI p95
limit is only 9 ms. Host contention, larger pages and the one-hour resource and
endurance gates remain to be qualified. No timing thresholds were relaxed.

## Extended hour pass: 2026-10-14

The extended normal-firmware run on clean revision
`c286ba68fa7db9c6e6c24644292a2f0a447f8945` completed with
`hour-workload-passed`; the separate Docker resource assessment also passed.
Measurement ran from **13:20:24.050 to 14:20:24.988 UTC** for
**3600.939 seconds**, after a 60-second warmup. No source, firmware or runtime
configuration was changed during measurement. Non-Markdown source SHA-256
matched before and after:
`374ce672ec39e015c4b122a090e3214f66f75f4d009b8d4210e8363310e51689`.

| Evidence | Result | Existing criterion |
| --- | --- | --- |
| Commands / Verified observations / archived changes | 57,600 / 57,600 / 57,600 | Exact complete count and ordered history |
| Missed generator ticks | 0 | 0 |
| Command acceptance p95 | 162.55 ms | At most 200 ms |
| UI transitions / alarm transitions | 3600 / 3600 | Exact ordered physical transitions |
| UI delay p95 / p99 / max | 362 / 437 / 611 ms | p95 at most 500 ms; p99 at most 1000 ms |
| Graph starts / late / skipped | 36,721 / 0 / 0 | Existing 100 ms graph timing bounds |
| Graph start delay p99 / max | 8 / 34.30 ms | p99 at most 50 ms |
| Maximum gateway arrival-to-state time | 12.60 ms across 60,226 samples | Existing per-gateway p95/p99 checks passed |
| Peak summed container working set | 2.834 GiB | At most 12 GiB |
| Final memory-window change | -1.58% | At most 5% growth |

Command, archive and UI counts above cover the measured hour; graph/gateway
counters include activation, warmup and final qualification reads.

Request-to-Verified-and-observed p95/p99/max were 546.02/703.80/1194.07 ms.
Generator lateness p95/p99/max was 8.45/18.09/373.49 ms; the one-period
rejection threshold remained unchanged. Archive drop, write-failure and
observer-failure counters stayed at zero. The graph's maximum execution time
was 35.66 ms. The resource assessment used 122 samples with consistent
container membership and acceptable sampling gaps; peak summed CPU was
345.39% across the monitored containers on a four-CPU shared host. This is
measured Docker CPU usage, not an additional CPU capacity guarantee.

Private artifacts: `l0-2026-10-14T13-19-16.906Z` and
`l0-host-df232ca8c05747cca83b11e1e8f7e309`. They contain command receipts,
per-signal history, UI transitions, alarms, graph/gateway timing, metadata,
resource samples, resource verdict and post-run source fingerprint. Both the
workload and independent supervisor completed cleanup. The physical bench and
all load targets stopped, and the virtual Climate demo was restored.

This closes the extended **16-device / 16-output** hour and resource gates for
this revision and observed environment. It does not prove the sole cause of
earlier failures, erase their evidence, establish hard real-time guarantees,
or qualify 200 signals or 10,000 devices. Continuous electrical trace, radio
and power interruption, additional physical I/O and the other
[M1 release boundaries](m1-reliability.md#remaining-release-boundaries) remain
open. No threshold relaxation or retry-until-pass was used.
