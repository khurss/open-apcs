# Mixed 200-signal endurance qualification

## Scope and fixed acceptance contract

The `mixed-200` profile extends the supervised L0 fixture with 13 virtual input
banks and the reviewed physical ESP32 GPIO18 LED. Twelve banks have 15 numeric
inputs each; the final bank has six. Together with their 13 virtual LED outputs
and the physical output, this is **186 numeric inputs and 14 boolean outputs**
across 14 active devices. The existing 16-device runtime limit is unchanged.

Run `scripts/run-l0.py` with the same private bench/artifact variables documented
in [L0](load-l0.md), plus `APCS_L0_PROFILE=mixed-200`. The default remains
`led-16`; its catalog and historical results are not replaced. Duration defaults
to 3600 seconds; `APCS_L0_SECONDS=60` selects a short smoke check. Both runs have
60 seconds of warmup. No credentials belong in the repository.

The host orchestrator captures the profile, source fingerprint, revision,
container placement and resource samples. The independent supervisor retains
responsibility for stopping every registered simulator, the timing graph and
physical commissioning on failure or interruption. Stop existing runtimes before
starting; restore the virtual demo after qualification. No fault injection or
firmware change is part of this workload.

Each output receives one alternating audited command per second, staggered
across the 14 devices. The normal L0 gates still require every command Verified,
every output transition archived, zero missed command ticks, command acceptance
p95 <= 200 ms, physical UI p95 <= 500 ms / p99 <= 1000 ms, alarm transition
coverage and the read-only 100-block graph timing gate.

Numeric channels produce one private MQTT bank frame per second. Runtime
snapshots immediately before and after the measurement establish an inclusive
sequence range for each channel. The archive must contain every sequence exactly
once, with the same boot, Good quality, correct channel-specific sawtooth value
and strictly increasing receive timestamps. Sequence differences must cover at least duration minus one second, and
receive-time coverage must span at least duration minus two seconds. Extra
boundary samples are allowed only when their receive-time span supports the
additional one-Hz intervals; a larger sequence range cannot mask missing rows.

The full signal page is loaded in Chromium. Every numeric value/quality change
is captured after two animation frames, drained every five seconds and preserved in
`numeric-ui.jsonl`. For each channel, every archived value in its exact sequence
range must match the ordered browser evidence. Each channel independently must
meet p95 <= 500 ms and p99 <= 1000 ms. Missing or coalesced values fail; later
values cannot substitute for a missing transition. This measures rendering
opportunities, not optical display paint. `bank-qualification.json` preserves
per-channel counts and percentiles; the result records aggregate counts and the
worst channel p95/p99.

A one-hour workload pass also requires the separate host resource evaluator:
peak aggregate memory <= 12 GiB and <= 10% late-window memory growth
(owner-approved policy v2; the original v1 limit was 5%), with complete
container samples. The live application, database, gateways, browser and their
containers share the existing development server. Ordinary regression tests must
not run during the timed acceptance measurement.

## Evidence status

The corrected 180-second smoke passed on 2026-10-14: 2520 Verified/archived
commands, 186 numeric channels and 33,837 boundary-inclusive samples, no missed
ticks. Worst-channel UI p95/p99 were 414/588 ms and command acceptance p95 was
190.90 ms. The earlier hour attempt aborted at the minute-sized evidence drain;
five-second drains and reserved simulator sample slots address the observed
failures. The subsequent hour passed workload checks but failed the resource growth gate,
as detailed below. The owner subsequently accepted this run under policy v2 (see below). A short functional or
smoke pass does not establish one-hour performance. This profile does not qualify
10,000 devices, 100,000 signals, radio interference, power loss or continuous
electrical waveform correctness.


## Hour workload pass, resource rejection (2026-10-14)

Clean revision `626aaa42d2e204e6072d82dd963413817c1107c6` ran for
3600.929 measured seconds, from 20:08:01.446 to 21:08:02.422 UTC.
The non-Markdown source fingerprint was verified unchanged after the run:
`6d76f4a3b62c4532f60c49870bd8f1b2314b1df019d4bdf78dd51400f9ec88f7`.
Private artifacts remain under `.cache/hil/` (not committed):

- Workload: `l0-2026-10-14T20-06-51.699Z`.
- Host/resource evidence: `l0-host-3e900cbbe98b46c1a5f42bf9e38f5057`.

| Check | Observed result |
| --- | --- |
| Commands requested / Verified / archived | 50,400 / 50,400 / 50,400 |
| Missed command ticks | 0 |
| Numeric channels / boundary-inclusive samples | 186 / 669,972; all passed |
| Worst numeric channel UI p95 / p99 | 364 / 476 ms |
| Command acceptance p95 / p99 / maximum | 194.90 / 353.02 / 1184.72 ms |
| Physical UI transitions / p95 / p99 | 3,600 / 319 / 419 ms |
| Alarm transitions | 3,600 |
| Graph starts / late / skipped | 37,239 / 0 / 0 |
| Graph start delay p99 | 8 ms |
| Archive drops / errors / observer failures | 0 / 0 / 0 |
| Resource samples / aggregate peak | 124 / 3.794 GiB |
| Late-window memory growth | **8.326%; FAIL (limit 5%)** |

The workload report says `hour-workload-passed`; the overall host command exits
nonzero because resource acceptance fails. This is **not a full mixed-200
qualification pass**. Peak CPU across sampled containers reached 387.15% on the
four-logical-CPU host. The acceptance latency p95 passes narrowly; its maximum
is not a guaranteed command-response bound.

Comparing the evaluator's five-minute baseline and final windows gives these
mean memory changes (Docker container accounting, not heap measurements):

| Container | Baseline MiB | Final MiB | Change MiB |
| --- | --- | --- | --- |
| Load generator and Chromium | 1300.6 | 1493.9 | +193.3 |
| API | 560.5 | 620.4 | +60.0 |
| PostgreSQL | 492.5 | 531.5 | +39.0 |

The load generator retains all numeric UI events in `bankEvents` while also
writing them to disk. This is a concrete unbounded retention path and a candidate
for the largest increase; the container measurements alone do not attribute all
of its growth to that array or prove an application leak. API and database growth
also require investigation. At the time of this rejection no change to resource accounting or thresholds
was authorized. The subsequent owner decision below supersedes the growth limit
only; all measured containers remain included.

Deferred performance follow-up (no longer blocks this accepted increment):

1. Add a failing test for bounded numeric evidence storage and preserve exact
   ordering, malformed-record detection and every-event verification.
2. Drain numeric events to per-channel evidence on disk, then verify one channel
   at a time; do not retain the entire hour in memory.
3. Diagnose remaining API growth using bounded-state and heap evidence, keeping
   PostgreSQL cache growth separate from application retention.
4. Run Docker regression checks and a smoke workload, then repeat the unchanged
   hour and resource gates on a recorded revision.

After this run, the virtual Climate demo and its PID graph were restored and
verified running; API readiness was confirmed and the physical GPIO18 runtime
was stopped. No firmware or electrical-waveform qualification is implied.


## Owner acceptance and policy v2 (2026-10-14)

After reviewing the failure above, the owner explicitly accepted the run and
requested lower requirements and progression to the next development increment.
The mixed-200 growth limit is now **10%**; peak memory remains **12 GiB**. All
command, numeric sequence, UI, archive, timing, duration and resource-completeness
criteria remain unchanged. The default led-16 profile retains its **5%** limit.

Docker re-evaluation of the same 124 resource samples passes policy v2:
8.3258% growth and 3.794 GiB peak. This is a **policy re-evaluation of the existing
hour**, not a new endurance run or a memory fix. Original `resource-result.json`
and the nonzero original host exit remain intact. `resource-result-v2.json`
records profile, policy version, threshold and the new assessment separately.

This mixed-200 increment is accepted under the revised requirements. Memory
retention investigation remains a nonblocking backlog item. It does not establish
unlimited runtime, resolve the observed retention, or complete remaining M1
hardware scenarios, M2 or the larger capacity profiles. Development proceeds to
[signal presentation settings](signal-presentation.md).
