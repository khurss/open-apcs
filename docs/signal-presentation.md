# Numeric signal presentation

This M2 increment adds display-only metadata to float64 signals. In Signals,
expand **Display settings**, enter a unit label (up to 24 characters) and choose
0–6 decimal places, then save. The live monitor renders the rounded value with
the unit. An empty unit and two decimals preserve the previous default.

These settings do not convert units, scale telemetry, round stored values,
change graph inputs or affect commands. The unit is an operator-supplied label;
the system cannot verify that it describes the source measurement correctly.
No-data and boolean displays stay unchanged. History tables, charts, HMI widgets
and CSV/PDF snapshots retain their existing presentation in this delivery;
propagation to those surfaces requires a subsequent versioned contract.

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
