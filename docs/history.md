# Signal history: initial raw archive

The private simulation worker records signal history without a browser. In Signals, choose **History** to inspect value and quality changes after a device has stopped. The default view follows the last hour and refreshes every two seconds; a manual date range pauses following. Times display in the browser's local timezone. The API stores UTC server observation times and retains original source/receipt metadata in each snapshot.

## Acquisition and persistence

SignalStore provides synchronous observation subscribers. Accepted samples produce observations, including rapid digital edges. Duplicate, out-of-order, and obsolete-session samples produce no archive observation. Disconnect and detected Stale transitions retain the last value. Subscribers receive independent snapshot copies; a throwing subscriber cannot prevent acquisition or another subscriber. Observer failures are counted. Subscribers must enqueue synchronously and must not perform blocking work.

HistoryBuffer records value, quality, or boot changes plus a checkpoint after 60 seconds without a recorded change. Checkpoint timing uses a monotonic clock. Its default queue capacity is 4,096 observations, and storage batches contain at most 100 records. When full, it drops new observations and increments a visible cumulative counter; it does not block commands. Failed storage writes retain the bounded batch and retry the same event IDs. Copies isolate buffer contents from a writer's mutation.

HistoryService samples registered signal quality and flushes one batch every 250 ms after the preceding cycle finishes. It has no overlapping archive writes or browser dependency. PostgreSQL inserts each batch transactionally. Identical event IDs/data are idempotent; conflicting identities or a missing signal roll back the whole batch. Signal quality and exact string values survive JSON storage. A separate ordinal resolves equal observation timestamps and provides stable pagination.

Command acceptance and acknowledgement do not depend on archive availability. The runtime status exposes queue depth, dropped observations, storage failures, observer failures, written records, pruning count, and maintenance errors. Database errors are reported without exposing SQL details. The buffer is volatile: process termination or a shutdown that cannot drain it can lose buffered observations. This is not a lossless historian or a production sizing claim.

## Retention and query bounds

Migration `003-signal-history.sql` introduces the raw history table and range/retention indexes. Every minute the running archive service removes records older than seven days, in up to ten batches of 1,000 rows. Maintenance is bounded and eventual; it does not run while the private worker is stopped. Annual aggregates, incident retention, analog deadband, and late-data recalculation remain M2 work. This increment retains raw samples only and must not be described as the complete seven-day/raw plus one-year/aggregate policy.

Server observation time is separate from device source time. Host wall-clock changes can change chronological display order; equal timestamps use the archive ordinal. Command/logic duration semantics remain monotonic. Dedicated historian clock-discontinuity handling and gap accounting across abrupt worker loss remain future work.

| Route under `/api/v1` | Behavior |
|---|---|
| `GET /signals/:id/history?from=<ISO>&to=<ISO>&limit=100&before=<ordinal>` | Authenticated project-owner query; up to seven days per range, 1–1,000 rows per page, newest first |
| `GET /history/status` | Private worker archive status and bounded-buffer diagnostics |

The UI requests 100 rows per page and limits its loaded table to 1,000 rows. Narrow the range to inspect a different interval. A cursor removed by retention must be replaced by a fresh query. Values with Bad, Stale, or Disconnected quality are displayed explicitly; absence of data is not OFF or zero. Plotting, aggregate queries, and reports are later increments.

## Verification scope

Domain tests cover observation ordering, stale/disconnect events, subscriber isolation, and unsubscribe. Buffer tests cover rapid changes, checkpoints, capacity exhaustion, stable retry IDs, writer failures, and non-overlap. PostgreSQL tests cover transactional batches, identity conflicts, exact strings, tied timestamps, cursor bounds, and retention cutoffs. Runtime tests verify archival without browser reads and successful control through an archive outage. API and browser tests inspect persisted value/quality data, and the backup drill restores an actual history sample.
