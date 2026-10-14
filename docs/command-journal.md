# PostgreSQL command journal: the first implemented contract

`@open-apcs/storage/command-journal` provides `PgCommandJournal`. This storage and dispatch-intent library handles boolean outputs for the LED milestone. The authenticated HTTP API exposes commands, paged history, and explicit virtual and isolated ESP32 LED recovery. The separate [LED gateway/runtime](led-network.md) now connects this library to MQTT delivery and periodic recovery. PostgreSQL in `compose.test.yml` uses tmpfs for tests only; a production installation requires a separate persistent volume and backups.

## Stored data

The migration at `packages/storage/migrations/001-command-journal.sql` creates commands, transition history, and the outbox. An accepted request and its pending outbox entry commit in one transaction. Rejected requests also retain their reason and history, without a delivery task. ACK state changes and new history events are atomic as well.

Migrations run under an advisory lock and store their version and the SHA-256 of the SQL source. Repeating a migration is safe; modifying an applied migration or encountering an unknown schema version raises an error. Further changes require a new migration rather than editing an installed version.

Each transaction uses one dedicated `pg` client, following the [node-postgres transaction contract](https://node-postgres.com/features/transactions). Trusted Pool configuration sets the SQL context/schema. The library does not accept schema names from user requests.

## Operations

| Method | Result |
|---|---|
| `migrate()` | Validate and apply the schema |
| `request(request, context)` | Persisted snapshot; the same actor/key/payload returns the original ID |
| `get(id)` | Snapshot with expiration applied; resulting state changes are persisted |
| `claimNext(resolveContext, targetSignalId?)` | At most one intent, optionally scoped to an output, returned only after a successful COMMIT |
| `acknowledge(ack)` | Correlated ACK validated against command ID, output, boot session, and expected value |
| `recoverExpired(limit = 100)` | Bounded scan of expired commands and detected clock regressions; maximum 1000 |
| `connectionLost(targetSignalId)` | Pending → Cancelled; Dispatched/DeviceAccepted → Unknown |

Trusted backend components provide `actorId`, current revision, ownership, boot session, quality, and interlocks. The HTTP layer derives the actor from the authenticated session rather than client JSON. This library does not implement authentication, the device catalog, or user authorization.

## Concurrency and recovery

A unique `(actor_id, idempotency_key)` constraint and transaction lock protect idempotency. A different payload with the same key is rejected. A new command ID in a repeated HTTP request does not replace the original ID.

The initial release permits one unfinished command per output. Accepted, Dispatched, DeviceAccepted, and Unknown occupy the output; a new command is stored as Rejected with a reason. A partial unique index also enforces this under concurrent requests. Verified, explicit Failed, Expired, Cancelled, or Rejected releases the output.

`claimNext` uses `FOR UPDATE SKIP LOCKED`, checks fresh context, and marks the outbox consumed together with Dispatched. This applies locking to a queue; it is not a general mechanism for reading a consistent data snapshot. See [PostgreSQL SELECT locking clauses](https://www.postgresql.org/docs/17/sql-select.html#SQL-FOR-UPDATE-SHARE).

Consumed entries never automatically return to pending. If the process crashes after COMMIT but before publication, the library cannot determine whether a physical action occurred. The outcome becomes Unknown after the deadline; the intent is not reissued. This is **not an exactly-once delivery or physical-action guarantee**. At this layer, Dispatched means that the start of an attempt was recorded, not that a broker received a message or a GPIO changed.

A resolver or transaction failure returns no intent. The resolver receives an AbortSignal, performs read-only live-state access, and defaults to a 1000 ms timeout; `contextTimeoutMs` permits 1–5000 ms. Timeout rolls back the transaction and releases its lock. An arbitrary resolver that ignores AbortSignal cannot be forcibly stopped within the JavaScript process: it must not have side effects or create unbounded resources.

One `claimNext` call considers at most one record. `null` may mean no available record, rejection, or expiration. The future dispatcher must keep polling rather than treating `null` as permanent queue completion. Periodic `recoverExpired` calls are also the runtime's responsibility.

An unresolved Unknown outcome blocks its output. A late ACK does not erase the original uncertainty or release the output. Explicit reconciliation is available for virtual profiles and the isolated ESP32 LED bench under the conditions below. Editing database tables manually is not a supported recovery procedure.

## Time and current implementation boundary

PostgreSQL stores an absolute `expires_at`; retries and object restoration do not extend it. After reading database time, the operation tracks the remaining interval monotonically, including time spent awaiting the resolver. A negative remainder produces Expired/Unknown. A detected database clock regression relative to `last_observed_at` cancels pending commands and marks dispatched commands Unknown.

Between operations, command age depends on the PostgreSQL system clock. A partial clock rollback that does not cross the last stored observation is not detected by this comparison. Before controlling physical outputs, the protocol/firmware must independently validate command age and control sessions, monitor clock skew, and implement a local watchdog. A database deadline does not replace these controls. An intent can also expire after COMMIT; the dispatcher must verify the deadline and current authority immediately before I/O. The LED adapter uses the same-process `deadlineMonotonicMs` field; COMMIT time consumes its budget.

Automatic publication retries, runtime-wide HA/fencing, general actuator reconciliation, annual history retention, and a complete database privilege model are not implemented. Snapshots hold a short command transition history, also stored as individual event rows. Storage currently grows with request count; retention/archiving is required before a long-running production deployment.

## Docker verification

```bash
make install
make test
make watch-integration
```

Each journal test creates a separate random PostgreSQL schema and removes it afterward. Coverage includes concurrent requests/workers, a new Pool connection, repeated migration, migration drift, outbox/ACK rollback, COMMIT failure, deadline expiration, connection loss, late ACK, and a stalled resolver. A failure after claim is modeled by stopping delivery and creating another repository instance; it is not a physical server power-loss test.

Tests use the existing container environment without rebuilding images. TypeScript and SQL migration changes trigger reruns; SQL loaded through `fs` is covered by [forceRerunTriggers](https://vitest.dev/config/forcereruntriggers).

## Explicit LED reconciliation

Migration `002-reconciliation.sql` adds a separate reconciliation receipt and changes the unfinished-output index. It never rewrites migration 001, the original command outcome, command transition history, or evidence. A reconciled command remains Unknown; the receipt means an operator deliberately released the output for future commands, not that the old command was verified or failed.

`reconcile(id, actorId, reason, resolveTrustedContext, onAudit?)` locks the output and command. It requires an Unknown outcome, a nonempty explanation, the current output owner, Good quality, no interlock, a new device boot ID, and an observed OFF value. OFF is the configured LED demonstration safe state; this policy is not a universal process safe-state policy. The trusted resolver has the same bounded timeout as dispatch context. Concurrent identical requests return the first receipt without duplicating its audit; conflicting actor/reason changes are rejected. The audit callback runs in the same transaction: any error preserves the block. No command or outbox entry is created by reconciliation.

The authenticated API supports:

- `GET /signals/:id/commands?before=<command-id>`: the catalog profile, ten newest snapshots per page and an independently selected `blocking` command, so rejected requests cannot hide an older blocker.
- `POST /commands/:id/reconcile`: `{reason, acceptUnknownOutcome: true}`. The server derives actor and observed state; supplied actors, values, boot IDs, and other fields are rejected. Physical ESP32 LED requests additionally require `gpio` and `acknowledgeLedOnly: true`, with an active matching commissioned GPIO. See [physical recovery](physical-recovery.md).

In the command panel, inspect the unknown outcome, stop and restart the virtual device, reopen control, and provide a recovery reason plus acknowledgement that the original outcome remains unknown. The server checks the new session and OFF observation. Reconciliation does not restart equipment, restore graph ownership, replay a request, or automatically send the next command. The operator may issue a separate new intent afterward. Receipts remain attached to snapshots across API/database reconnection and are included in ordinary database backups.

The browser recovery test injects loss after a durable dispatch claim directly into its isolated PostgreSQL fixture, then uses the real worker/MQTT simulator for recovery and the next Verified command. Fixture schema metadata is written to an ignored `.cache/e2e` file using a repository-relative URL; no fault-injection HTTP route exists in the application. The browser fixture runs one worker per workspace.

Verified command receipts are read without rewriting the completed row or generating another WAL record. Unfinished states retain transactional clock/expiry checks; this optimization does not weaken acknowledgement, timeout or reconciliation rules.
