# Alarm monitoring

The initial alarm profile runs in the private simulation worker independently of the browser. Rules bind a project signal to a boolean condition or a set of quality states. Creation requires project ownership, a matching signal, and an atomic audit record. The initial workspace limit is 100 immutable rules. Editing, deletion, bulk actions, numeric thresholds, routing, and notifications remain future deliveries.

## Lifecycle

An occurrence is open until its cause has returned and it has been acknowledged. States are Normal, ActiveUnacknowledged, ActiveAcknowledged, and ReturnedUnacknowledged. A return without acknowledgement retains the occurrence; another activation produces Reactivated with the same occurrence number. A new activation after acknowledgement and return increments the occurrence. Acknowledgement carries an expected occurrence, authenticated actor, and reason. It cannot clear the cause or send equipment commands.

Boolean conditions require a Good boolean sample. Unavailable input resets pending delay timers and preserves the existing active/acknowledgement state. Quality conditions can explicitly detect Bad, Stale, and Disconnected. Activation and return delays use monotonic time; the operator form exposes activation delay, and the API supports both delays. Evaluation samples the latest state approximately every 100 ms after the previous cycle finishes; shorter transients can be missed. This monitor is not an independent protective function.

Suppression has an actor, reason, and duration from one second to one day. It does not change the cause or acknowledgement. Expiry uses monotonic time. The initial UI offers one minute. Notification delivery is not implemented yet; suppression currently records notification eligibility and operator intent, while state evaluation and event recording continue.

## Persistence and failure

PostgreSQL stores the state, ordered versioned lifecycle events, last evaluation time, and audit. An operator action succeeds only after all changes commit in one transaction. A failed audit or storage write rolls back the state and faults the monitor. Equipment control remains a separate service. Restart is required after a monitor fault; unsaved in-memory changes are discarded.

Restart restores active occurrences and acknowledgements, resets delay timers, invalidates prior input availability, and clears suppression with a recorded reason. Monitoring begins after the first successful virtual-device start in the worker and continues after devices stop. A replacement worker is initially stopped and does not rearm outputs. Passive automatic startup and durable notification delivery remain future work.

The API marks evaluations older than three seconds or never evaluated as stale. The UI also checks worker status and request availability, labeling such rows Not current. A displayed historical Normal phase with Not current is not evidence of a healthy process. A bounded polling request aborts after 2.5 seconds. SQL state-version checks reject a competing stale writer; the runtime additionally holds its workspace ownership lock.

## API

All routes require a local session. Mutations require the existing origin/CSRF checks.

- `POST /api/v1/projects/:id/alarms`: name, signalId, priority (low/medium/high), definition. Definition contains condition, activationDelayMs, and returnDelayMs.
- `GET /api/v1/projects/:id/alarms`: at most 100 rules, states, phases, and evaluation freshness for the owned project.
- `GET /api/v1/alarms/:id/events?before=<event-id>`: newest 20 events with nextBefore cursor. The initial UI displays the latest 20.
- `POST /api/v1/alarms/:id/actions`: kind=acknowledge with occurrence and reason; kind=suppress with durationMs and reason; or kind=unsuppress with reason.
- `GET /api/v1/alarms/status`: stopped/running/faulted, rule count, and generic monitor fault.

These contracts implement basic virtual-device alarms within partial M1. SMTP/webhooks, alarm flood handling, configurable event retention, incident capture, and hardware acceptance are not completed by this increment.
