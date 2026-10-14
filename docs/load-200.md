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
peak aggregate memory <= 12 GiB and <= 5% late-window memory growth, with complete
container samples. The live application, database, gateways, browser and their
containers share the existing development server. Ordinary regression tests must
not run during the timed acceptance measurement.

## Evidence status

The corrected 180-second smoke passed on 2026-10-14: 2520 Verified/archived
commands, 186 numeric channels and 33,837 boundary-inclusive samples, no missed
ticks. Worst-channel UI p95/p99 were 414/588 ms and command acceptance p95 was
190.90 ms. The earlier hour attempt aborted at the minute-sized evidence drain;
five-second drains and reserved simulator sample slots address the observed
failures. Full one-hour/resource qualification is pending. A short functional or
smoke pass does not establish one-hour performance. This profile does not qualify
10,000 devices, 100,000 signals, radio interference, power loss or continuous
electrical waveform correctness.
