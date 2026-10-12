# Signal history, trends and aggregates

The private simulation worker records signal history without a browser. In Signals, choose **History** to inspect value and quality changes after a device has stopped. The default view follows the last hour and refreshes every two seconds; a manual date range pauses following. Times display in the browser's local timezone. The API stores UTC server observation times and retains original source/receipt metadata in each snapshot.

## Acquisition and persistence

SignalStore provides synchronous observation subscribers. Accepted samples produce observations, including rapid digital edges. Duplicate, out-of-order, and obsolete-session samples produce no archive observation. Disconnect and detected Stale transitions retain the last value. Subscribers receive independent snapshot copies; a throwing subscriber cannot prevent acquisition or another subscriber. Observer failures are counted. Subscribers must enqueue synchronously and must not perform blocking work.

HistoryBuffer records value, quality, or boot changes plus a checkpoint after 60 seconds without a recorded change. Checkpoint timing uses a monotonic clock. Its default queue capacity is 4,096 observations, and storage batches contain at most 100 records. When full, it drops new observations and increments a visible cumulative counter; it does not block commands. Failed storage writes retain the bounded batch and retry the same event IDs. Copies isolate buffer contents from a writer's mutation.

HistoryService samples registered signal quality and flushes one batch every 250 ms after the preceding cycle finishes. It has no overlapping archive writes or browser dependency. PostgreSQL inserts each batch transactionally. Identical event IDs/data are idempotent; conflicting identities or a missing signal roll back the whole batch. Signal quality and exact string values survive JSON storage. A separate ordinal resolves equal observation timestamps and provides stable pagination.

Command acceptance and acknowledgement do not depend on archive availability. The runtime status exposes queue depth, dropped observations, storage failures, observer failures, written records, pruning count, and maintenance errors. Database errors are reported without exposing SQL details. The buffer is volatile: process termination or a shutdown that cannot drain it can lose buffered observations. This is not a lossless historian or a production sizing claim.

## Retention and query bounds

Migration `003-signal-history.sql` introduces raw history. Migrations 007–008 add minute/hour calculations, dirty jobs, bounded backfill and the retention admission boundary. The application targets seven days of ordinary raw input and 365 days of minute/hour aggregates. Whole boundary hours and predecessor anchors extend raw retention by up to about 64 minutes. Backlog or blocked calculations retain raw source data longer; maintenance is bounded and eventual. A private aggregation worker runs without an armed device or browser. See [aggregate semantics and limits](history-aggregates.md). Disk quotas, target-scale sizing, counter profile configuration, incident retention and analog deadband remain pending.

Server observation time is separate from device source time. Host wall-clock changes can change chronological display order; equal timestamps use the archive ordinal. Command/logic duration semantics remain monotonic. Dedicated historian clock-discontinuity handling and gap accounting across abrupt worker loss remain future work.

| Route under `/api/v1` | Behavior |
|---|---|
| `GET /signals/:id/history?from=<ISO>&to=<ISO>&limit=100&before=<ordinal>` | Authenticated project-owner query; up to seven days per range, 1–1,000 rows per page, newest first |
| `GET /history/status` | Private worker archive status and bounded-buffer diagnostics |

The UI requests 100 rows per page and limits its loaded table to 1,000 rows. Narrow the range to inspect a different interval. A cursor removed by retention must be replaced by a fresh query. Values with Bad, Stale, or Disconnected quality are displayed explicitly; absence of data is not OFF or zero. The loaded raw page also provides a bounded trend and CSV export as described below. The same panel can open minute/hour aggregate queries. PDF/scheduled reports remain later increments.

## Verification scope

Domain tests cover observation ordering, stale/disconnect events, subscriber isolation, and unsubscribe. Buffer tests cover rapid changes, checkpoints, capacity exhaustion, stable retry IDs, writer failures, and non-overlap. PostgreSQL tests cover transactional batches, identity conflicts, exact strings, tied timestamps, cursor bounds, and retention cutoffs. Runtime tests verify archival without browser reads and successful control through an archive outage. API and browser tests inspect persisted value/quality data, and the backup drill restores an actual history sample.

## Loaded-page trend and CSV export

The history panel plots the loaded observations, up to its existing 1,000-row limit. The horizontal extent is the oldest to newest loaded timestamp, not an assertion of complete coverage of the requested range. Boolean values use 0/1 with OFF/ON labels; finite numeric values are shown without unit conversion. Good observations have point markers. A horizontal segment holds a value only until the next observation, provided that both observations belong to the same nonempty device session and are no more than 120 seconds apart. Bad/Stale/Disconnected observations, session changes and longer gaps break the trace. Nothing is extrapolated past the latest observation. A tooltip gives local time/value; the table remains the accessible detailed representation.

String values, including exact int64 decimals, are deliberately not converted to floating point for plotting. They remain exact in the table and export. Equal observation timestamps use the archive ordinal as a deterministic tie-breaker. A chart does not reconstruct edges dropped before archival or data outside the loaded page.

**Export loaded CSV** downloads the current loaded rows in ascending observation/ordinal order, including the signal identity/name/type, archive identity, UTC observation time, JSON-encoded value, quality, device boot/session, sequence and original source/receipt timestamps. JSON value encoding distinguishes boolean, null, number and exact string/int64 values. Cells use CSV quote escaping and CRLF records. Potential spreadsheet formulas in text metadata receive a leading apostrophe; consumers that require original metadata must account for that protective prefix. Negative numeric JSON values remain numbers; untrusted string values retain their JSON quotes. UTF-8 user-defined names are preserved.

Export is local to the already authorized browser view and sends no commands. It does not fetch unshown pages or claim to export the entire requested period. The button and row count make that scope explicit. Annual minute/hour aggregates are available separately through Show aggregates. Complete server-side report jobs, PDF output and scheduled summaries remain on the roadmap.
