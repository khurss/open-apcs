# Alarm monitoring

The initial alarm profile runs in the private simulation worker independently of the browser. Rules bind a project signal to a boolean condition, a numeric high/low threshold, or a set of quality states. Creation requires project ownership, a matching signal, and an atomic audit record. The initial workspace limit is 100 immutable rules. Editing, deletion and bulk actions remain future deliveries. Durable local SMTP/webhook routes and delivery logs are described in [notifications](notifications.md).

## Lifecycle

An occurrence is open until its cause has returned and it has been acknowledged. States are Normal, ActiveUnacknowledged, ActiveAcknowledged, and ReturnedUnacknowledged. A return without acknowledgement retains the occurrence; another activation produces Reactivated with the same occurrence number. A new activation after acknowledgement and return increments the occurrence. Acknowledgement carries an expected occurrence, authenticated actor, and reason. It cannot clear the cause or send equipment commands.

Boolean conditions require a Good boolean sample. Unavailable input resets pending delay timers and preserves the existing active/acknowledgement state. Quality conditions can explicitly detect Bad, Stale, and Disconnected. Activation and return delays use monotonic time; the operator form and API expose both delays. Evaluation samples the latest state approximately every 100 ms after the previous cycle finishes; shorter transients can be missed. This monitor is not an independent protective function.

Suppression has an actor, reason, and duration from one second to one day. It does not change the cause or acknowledgement. Expiry uses monotonic time. The initial UI offers one minute. Suppression prevents new notifications while state evaluation and event recording continue; it does not recall already queued deliveries.

## Numeric thresholds

Threshold rules bind only float64 signals. The definition is `{ "kind": "threshold", "direction": "high", "threshold": 24, "deadband": 1 }`; `low` is the other direction. Values, threshold, deadband and the calculated reset boundary must be finite; deadband must be nonnegative. Boolean values, numeric strings and int64 strings are not coerced.

High alarms activate at or above the threshold and return strictly below `threshold - deadband`. Low alarms activate at or below the threshold and return strictly above `threshold + deadband`. Equality at the reset boundary holds the active state, including when deadband is zero. The persisted active state determines which boundary applies after restart.

An inactive alarm must remain beyond its trip threshold throughout the activation delay; entering the deadband cancels that pending activation. An active alarm must remain beyond its reset boundary throughout the return delay; entering the deadband cancels that pending return. Invalid/non-Good input cancels pending delays and marks evaluation unavailable while preserving the active occurrence and acknowledgement. Restart preserves these states but restarts pending delays. Acknowledgement never changes the threshold or commands an output.

The operator form filters compatible signal types and displays each rule's trip/reset boundaries. Rules remain immutable and the 100-rule workspace limit still applies. The virtual thermal process provides a tested numeric source. These are monitoring conditions, not independent safety interlocks.

## Persistence and failure

PostgreSQL stores the state, ordered versioned lifecycle events, last evaluation time, and audit. An operator action succeeds only after all changes commit in one transaction. A failed audit or storage write rolls back the state and faults the monitor. Equipment control remains a separate service. Restart is required after a monitor fault; unsaved in-memory changes are discarded.

Restart restores active occurrences and acknowledgements, resets delay timers, invalidates prior input availability, and clears suppression with a recorded reason. With the configured runtime, passive monitoring begins after application migrations at server startup, before any browser request or device start. The supervisor repeats an idempotent passive-start request ten seconds after the previous request finishes. If the private worker exits, that request creates a replacement; a request can additionally take up to its existing five-second deadline. Replacement restores alarm evaluation, but devices and graphs remain stopped until explicitly started. Unstarted catalog signals evaluate as Disconnected; quality rules may activate immediately while boolean/numeric rules remain unavailable.

Passive monitoring acquires the same exclusive workspace database lock as control. A competing instance cannot start monitoring or equipment. Losing the lock session closes monitoring and control; a live faulted runtime requires a service restart. The supervisor does not clear alarm persistence faults, suppress database failures or restore output authority. Shutdown disables passive retries.

The API marks evaluations older than three seconds or never evaluated as stale. The UI also checks worker status and request availability, labeling such rows Not current. A displayed historical Normal phase with Not current is not evidence of a healthy process. A bounded polling request aborts after 2.5 seconds. SQL state-version checks reject a competing stale writer; the runtime additionally holds its workspace ownership lock.

## API

All routes require a local session. Mutations require the existing origin/CSRF checks.

- `POST /api/v1/projects/:id/alarms`: name, signalId, priority (low/medium/high), definition. Definition contains condition, activationDelayMs, and returnDelayMs.
- `GET /api/v1/projects/:id/alarms`: at most 100 rules, states, phases, and evaluation freshness for the owned project.
- `GET /api/v1/alarms/:id/events?before=<event-id>`: newest 20 events with nextBefore cursor. The initial UI displays the latest 20.
- `POST /api/v1/alarms/:id/actions`: kind=acknowledge with occurrence and reason; kind=suppress with durationMs and reason; or kind=unsuppress with reason.
- `GET /api/v1/alarms/status`: stopped/running/faulted, rule count, and generic monitor fault.

These contracts implement basic virtual-device alarms within partial M1. Alarm flood handling, configurable event retention, incident capture and hardware acceptance remain pending. Numeric thresholds extend the simulator-tested M2 profile; SMTP/webhooks use the same transactional event pipeline.
