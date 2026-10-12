# History aggregates

Status: implemented engineering profile within partial M2. Persistent minute/hour aggregates, late-data jobs, annual cleanup and a web history table are connected. Full target-scale capacity, disk quotas, counter profile configuration and reports remain pending; this is not scale acceptance.

## Calculation contract

Buckets use half-open UTC intervals and at most 10,002 samples (10,000 interior observations plus boundary anchors). The kernel accepts intervals up to one hour. Samples are sorted by observation time and exact archive ordinal; duplicate identities are rejected. First/last observations and counts concern samples inside the bucket. Min/max also include a held preceding value when its duration overlaps the bucket. Exact string values never pass through floating-point conversion.

A value is held only until a following observation in the same nonempty device session, with at most 120 seconds between observations. This matches the initial 60-second checkpoint profile. Nothing is extrapolated after the last known observation. An observation with Bad/Stale/Disconnected quality starts that quality interval; the preceding Good interval ends at its timestamp. Session changes, long gaps, missing anchors and mismatched Good value types contribute Unknown coverage. All quality durations plus Unknown equal the bucket duration.

Analog means are weighted by covered Good milliseconds, with null for zero coverage. Convex blending avoids overflow from multiplying very large finite values by durations. Digital aggregates report ON/OFF milliseconds and continuous observed transitions; sample density does not weight those durations. A point with zero duration may still contribute to extrema. First/last fields retain their recorded quality and are not assertions of current process state.

The explicit counter64 kernel profile accepts unsigned 64-bit decimal strings and computes increments with BigInt, returning exact decimal totals. A decrease in a continuous Good sequence counts a reset to zero and contributes the new value. A gap or new device session does not invent an increment. Deltas are attributed to the newer observation's bucket; this does not claim to know when individual increments occurred between observations. Counter profile configuration in the application remains pending. The exact profile preserves other string values without numeric averaging.

## Persistent storage and execution

PostgreSQL minute and hour aggregate tables/jobs use the same semantic kernel. Raw inserts mark every bucket whose boundary/interior coverage could change within the continuity window. Aggregation runs only after a bucket closes and the continuity window elapses; late data within retained raw history marks it dirty again. Results are replaced transactionally while holding the corresponding job row, and concurrent raw writes leave a subsequent dirty job instead of losing recalculation.

Migration 007 installs an insert transition-table trigger and captures the maximum existing archive ordinal. A restartable backfill scans up to 1,000 existing rows per cycle; raw deletion is blocked until that scan completes. Aggregate jobs lock their own rows while reading, calculating and replacing a bucket transactionally. At most 10,000 interior observations and two anchors are loaded per job. Overflow or invalid source data leaves a visible blocked job with a one-minute retry delay; source rows remain protected. Job locks and source updates ensure a later insert schedules another calculation rather than losing the change. Identical archive batch retries do not dirty calculated buckets.

The intended retention is seven days of raw data and one year of minute/hour aggregates. Cleanup is eventual; outage/backlog diagnostics must explain temporary excess retention. No target-scale capacity claim follows from passing small engineering fixtures. The architecture's 4-CPU/16-GB/100-GB profile still requires measured sizing and disk quotas before scale acceptance.

## Retention boundary implementation notes

Raw insertion and pruning now share a short PostgreSQL transaction lock. Pruning advances an irreversible ordinary-ingestion boundary; older input requires a future explicit import/recalculation flow and cannot silently overwrite aggregates after their source rows have gone. The actual deletion threshold retains the complete earliest hour affected by a permissible late observation, plus its 120-second predecessor window. This extends raw retention by up to about 64 minutes for boundary correctness. Backfill must finish and all dependent minute/hour jobs must be complete before raw deletion; blocked aggregation keeps the raw source.

The implementation uses PostgreSQL [statement transition tables](https://www.postgresql.org/docs/17/sql-createtrigger.html) so an identical ON CONFLICT retry does not enqueue a new insert job. UTC bucket boundaries use [date_bin](https://www.postgresql.org/docs/17/functions-datetime.html). These contracts were verified with real PostgreSQL fixtures, including late inserts, retry identity conflicts, bounded overload, restartable backfill and retention admission. The background worker, annual cleanup and web/API integration use these same contracts.

## Worker, retention and web view

The API starts a private aggregation process immediately. It holds one PostgreSQL advisory owner lock per database/schema, uses a 128 MiB Node heap bound and restarts after failure without restoring any control authority. The worker scans one backfill page and up to four aggregate jobs per serial cycle, with a 250 ms delay between cycles. Calculations and raw cleanup share PostgreSQL coordination, but run outside the API and control event loops. A heartbeat older than ten seconds is reported unavailable. Shutdown waits for current bounded work; a killed process rolls its database transaction back.

Every minute the worker deletes up to 1,000 expired aggregate rows and 1,000 expired jobs. Complete buckets ending before the rolling 365-day cutoff expire. It also prunes up to ten batches of 1,000 raw rows within a one-second scheduling budget; one database operation can extend that budget to its own timeout. The existing runtime archive may also request raw cleanup; the same transaction lock and boundary rules serialize those requests. Cleanup is eventual and paused during worker failure. Raw observations older than 366 days may be discarded without an aggregate once backfill is complete, because the annual result itself has expired.

Automatic profiles are digital for boolean signals, analog for float64 and exact for int64/uint64 strings. The tested counter64 kernel is not yet selectable in application configuration. No numerical approximation is substituted for unsupported exact arithmetic.

In Signals → History, **Show aggregates** opens a minute/hour table. Select a UTC bucket resolution and a local date/time range of at most 365 days. Whole buckets are selected by start time; the requested range does not clip their statistics. The page loads 100 rows at a time, up to 1,000. The initial range is the preceding 24 hours at opening; refresh polls that applied range, while loading older pages pauses polling. The view shows observed counts, Good/Unknown duration, digital ON/OFF time and transitions, numeric mean/extrema, the last observation with its quality, and expandable Bad/Stale/Disconnected durations. Recalculation-pending rows are labeled explicitly.

Only buckets near archived observations are created; a missing bucket means no calculated coverage and must never be summed as an implicit zero. This table is not a complete-period report or multi-signal trend. Annual summaries, aggregate CSV/PDF jobs and incident capture remain separate work. Queries require authentication and signal-project ownership:

- `GET /api/v1/signals/:id/aggregates?from=<ISO>&to=<ISO>&resolution=60|3600&limit=100&before=<ISO>`
- `GET /api/v1/history/aggregates/status`

Migration 008 persists the ordinary-ingestion boundary. A database backup includes aggregate values, dirty jobs, backfill progress and that boundary. Restoring a backup can restart calculations without issuing device commands. Private workers and normal source changes use the existing Docker image and hot reload.

Observation-time ordering supports legitimate late arrivals; archive ordinal is only the tie-breaker. Insertion order alone cannot distinguish a delayed record from a host wall-clock step. Dedicated observation-clock epochs and authoritative discontinuity markers remain pending, so this initial profile must not be treated as clock-discontinuity-aware measurement. Source timestamps remain metadata and do not replace server observation time.
