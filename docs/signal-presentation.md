# Numeric signal presentation

This M2 increment adds display-only metadata to float64 signals. In Signals,
expand **Display settings**, enter a unit label (up to 24 characters) and choose
0–6 decimal places, then save. The live monitor renders the rounded value with
the unit. An empty unit and two decimals preserve the previous default.

These settings do not convert units, scale telemetry, round stored values,
change graph inputs or affect commands. The unit is an operator-supplied label;
the system cannot verify that it describes the source measurement correctly.
No-data and boolean displays stay unchanged. The follow-up display increment
applies numeric presentation to prepared HMI readings, HMI trends, raw-history
tables and aggregate value columns. Version 2 CSV/PDF reports now capture unit metadata and precision; raw numeric
CSV fields remain unrounded. See [report version contracts](reports.md#presentation-snapshot-version-2-2026-10-15).

`GET /api/v1/signals` includes `unit` and `displayDecimals`.
`PATCH /api/v1/signals/:id` accepts these optional fields alongside required
`name`, using the existing quoted `If-Match` revision and owner/CSRF checks.
Omitting either setting preserves its current value. A rename therefore cannot
silently reset presentation. Boolean signals reject supplied presentation fields.
Control characters, labels over 24 characters and precision outside 0–6 are
rejected. Invalid edits do not increment the revision. Conflicting edits return
412; the UI retains the error and asks the operator to refresh.

Migration 014 adds constrained fields with backward-compatible defaults. Metadata
updates and the audit record share a transaction; runtime addresses and signal
types stay untouched. UI editor state survives telemetry updates, while a new
catalog revision resets the form to the saved settings. Labels are rendered as
text, not HTML. This is an initial signal-metadata increment, not full engineering
unit conversion or a completed M2 release.


## HMI, history and trend display increment (2026-10-15)

The operator screen loads a snapshot of signal metadata on entry, by exact
binding identity, independently of catalog pagination. `GET /api/v1/signals/:id`
requires authentication and project ownership, returns the catalog signal shape,
and returns 404 for absent or foreign signals. Loading uses at most eight
concurrent requests, two-second per-request deadlines and cancellation on exit.
Duplicate bindings share one metadata request. No prepared screen document or
checksum is rewritten by a metadata edit.

Display settings are current catalog metadata, not part of a prepared revision
or a historical observation. Reopen the screen after changing units elsewhere.
A failed metadata load shows an explicit warning; affected readings use default
two-decimal display without a unit. Retry clears the previous snapshot and reloads
it. Telemetry and command authority continue to use their existing quality and
ownership contracts. Missing metadata never makes unavailable telemetry Good.

The readings list, SVG numeric values and accessible labels use the same
formatter. HMI trends pass metadata to history inspection instead of inventing a
label-only signal. History cells show the configured display value; their tooltip
retains the raw value. Aggregates format last value, mean and extrema while
keeping counts, durations, percentages and missing coverage unchanged. Integer
strings are not coerced into floating point. CSV export still contains original
unrounded values; the explicit version 2 format adds separate display metadata.

Trend geometry uses raw finite observations, with existing gaps and quality
rules. Axis labels use configured precision, falling back to scientific notation
when a label exceeds ten characters or a nonzero number would round to zero.
Point tooltips use the full configured display format. Units appear as a separate
wrapping caption so a long unit cannot consume the plot's axis margin. Boolean
trends retain ON/OFF labels. Mobile HMI trends use the same metadata and caption.

Acceptance includes API ownership/absence/authentication tests, numeric axis
format tests, and a real Chromium journey: configure the demo temperature, open
the prepared HMI, inspect its trend/history, inject metadata-service failure,
verify an explicit warning and unitless fallback, retry successfully, and inspect
the phone layout. The subsequent report increment adds versioned export snapshots as documented
above. Live cross-tab metadata synchronization is not claimed.
