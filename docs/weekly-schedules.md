# Weekly schedule blocks

Status: M2 engineering increment. The `schedule` block supplies a boolean level to ordinary control logic. It is not a cron job, a persistent action queue, or a safety function. Output commands use the existing ownership, interlock, quality, lease, journal, and verification path.

## Configuration and evaluation

`node.schedule` contains exactly `zone`, `days`, `startMinute`, and `endMinute`. The zone is a named time zone recognized by the server's bundled ICU data (for example `UTC`, `America/New_York`, or `Australia/Lord_Howe`); numeric offset strings are rejected. Days are unique ISO weekday numbers, Monday 1 through Sunday 7, with at least one selected. Boundaries are integer minutes from 0 through 1439.

A selected weekday identifies the **start** of a window. Start is inclusive and end is exclusive. An end earlier than the start crosses midnight. Equal boundaries mean a full local day starting at that time. The default block is UTC, Monday through Friday, 09:00 to 17:00. Multiple blocks and OR combine independent windows; holiday calendars, one-shot dates, calendar exceptions, and recipe jobs remain future work.

The calculation uses explicit UTC wall time and monotonic elapsed time. Runtime tasks supply both; pure engine callers must supply `LogicContext.wallTimeMs`. Simulation requires `startAt`, a canonical UTC ISO timestamp with milliseconds, for example `2026-10-12T08:59:59.000Z`. Each step's wall time is `startAt + atMs`; no current server time is substituted. Supported UTC dates are 1900 through 2100. Invalid time produces Bad quality rather than an OFF value.

## Daylight-saving and downtime policy

- If either local boundary does not exist, skip that entire window. Do not shift it into a later hour.
- If a boundary occurs twice, use its earliest UTC occurrence. A window ending in the repeated hour does not execute again during the second occurrence, including after a fresh engine start.
- A window spanning a clock transition can last longer or shorter in elapsed time. For example, midnight to midnight can cover 25 or 23 hours; the output stays continuous while inside the resolved interval.
- Evaluate only the current window. Never replay windows or pulses missed while stopped. Explicit activation inside an existing window can immediately request ON; activation review must account for this.

The implementation resolves both local boundaries to UTC and compares against that interval. It does not compare only the repeated clock-face time. Cached intervals are bounded to the current and previous local start dates. UTC elapsed time remains continuous through a normal zone DST transition.

At activation, a fixed pair of wall and monotonic clocks is captured. A difference exceeding 1000 ms between their elapsed times, invalid wall time, or reversed monotonic time latches a schedule fault. Restoring the clock alone does not clear it. A connected output becomes Bad; the graph task faults and revokes output authority before issuing further intents. Existing device lease expiry supplies the configured fallback. The operator must correct the clock, review the current window, and explicitly reactivate. This catches jumps, frozen wall time, and accumulated clock corrections; it does not prove the initial wall time is accurate. Configure and monitor a trusted local time source. Calendar blocks do not bypass independent hardware protections.

## Editor and offline operation

The visual inspector edits zone, weekdays, start, and end. The simulation bench exposes an explicit UTC date/time field for graphs containing schedules. JSON remains the same versioned graph format. Browser zone validation is a convenience; server validation and its bundled timezone rules determine execution.

No online timezone lookup is required. Runtime images pin the Node/ICU timezone data they contain. Timezone laws can change; update and review the offline runtime bundle before relying on changed rules. The current increment does not provide timezone database hot replacement or certify every historical timezone transition.

## Acceptance evidence

Docker tests cover inclusive/exclusive boundaries, overnight and full-day windows, missing spring boundaries, New York's repeated hour, Lord Howe's half-hour fold, fresh-start fold behavior, skipped downtime, cumulative clock drift, fault latching, mixed graph integration, explicit simulation time, and real MQTT command verification using an all-day virtual LED schedule. Browser coverage exercises visual settings and Monday/Sunday simulation in a named zone, with desktop and phone screenshots. Hardware timing and large schedule populations are not verified by these tests.

References: [ECMA-402 DateTimeFormat and formatToParts](https://tc39.es/ecma402/#sec-intl.datetimeformat.prototype.formattoparts) provides the local calendar components; [IANA Time Zone Database](https://www.iana.org/time-zones) describes maintained timezone rules. The skipped-window, first-occurrence, and clock-fault policies above are Open APCS decisions.
