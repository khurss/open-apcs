# Editor documents and isolated logic simulation

This increment provides basic graph and HMI editing, durable drafts, immutable prepared revisions, and isolated simulation. Prepared graphs also execute in the private simulation worker. The physical LED commissioning profile is available for bench testing; HIL acceptance, autonomous remote gateways, and the complete M1 release remain pending.

## Web workflow

Register a project and a virtual LED device. Open **Logic**, create a graph, and start with **LED template**, or add blocks individually. Move blocks on the canvas, connect their handles, and configure the selected block in Properties. A keyboard/touch connection form is also available. Delete connections there, or select an edge on the canvas and use Delete. Delete a selected block through Properties; its incident edges are removed.

Save the draft before simulation or revision preparation. The simulation bench runs 51 samples from 0 to 5000 ms in 100 ms increments, or six 1000 ms samples for script graphs. Boolean input blocks accept OFF, ON, or simulated disconnection. Numeric input blocks accept finite numbers or simulated disconnection; virtual thermal inputs also work live; physical numeric drivers remain pending. Results annotate the graph and list output values/reasons. Simulation uses a fresh engine and has no dependency on the command journal or hardware drivers.

Open **Screens** to arrange labels, indicators, buttons, and groups on an SVG scene. Configure signal bindings, coordinates, dimensions, and parent groups. Drag a group to move its descendants; coordinates are absolute scene coordinates. Arrow keys move a selected item by 10 px, or 1 px with Shift. Removing a group ungroups direct children. The design canvas never dispatches commands and its indicators are placeholders. Prepare a screen revision and choose Operate revision to see current signal values and open command controls.

Script blocks additionally provide an English JS/TS source editor; see [isolated script contracts](script-runtime.md). Both editors provide bounded undo/redo and a JSON document editor. JSON is a portable data representation; it is not JavaScript/TypeScript script execution or Structured Text support. Saved scenes and graphs survive API/browser restarts. Navigation prompts before discarding modified document state. A prepared revision does not activate equipment. Complex editing is oriented toward desktop/tablet; the phone interface provides controls and an internally scrollable HMI canvas.

## Typed graph contract

Schema version 1 contains `nodes` and `edges`. Node IDs and signal bindings are stable strings; API signal bindings must resolve to the owning project's catalog. Each edge connects a source block to a named target input port. Output blocks cannot be edge sources. One edge may feed each input port; fan-out is supported. A graph may contain at most 256 nodes and 1024 edges. Timers accept integer delays from 0 to 86,400,000 ms.

Draft validation permits unconnected input ports so incomplete work can be saved. Execution and revision preparation require all declared ports to be connected. All modes reject duplicate IDs, unknown fields/kinds/versions, cycles, invalid coordinates, and multiple output blocks bound to one signal. Cyclic feedback is not supported; latch state is internal to the block. These limits are an initial engineering profile, not the final scale target.

The engine copies its input graph, uses a deterministic topological order, and evaluates one snapshot per tick, awaiting isolated script results when present. Equal graphs, inputs, time sequences, and initial state produce equal results. Time must be finite, nonnegative, and nondecreasing. The engine uses no wall clock or I/O and does not perform catch-up ticks. A new engine resets all state; retained-state migration remains future work.

| Block | Ports and behavior |
|---|---|
| Constant | Boolean parameter; no inputs |
| Input | Read one boolean signal sample |
| Numeric constant | Finite float64 parameter; no inputs |
| Numeric input | Read a finite float64 input sample; live virtual-thermal or simulated float64 catalog binding |
| Add / Subtract / Multiply / Divide | Numeric `a`, `b`; produce a finite numeric result |
| Greater than / Less than | Numeric `a`, `b`; strict comparison, boolean output |
| Hysteresis | Numeric `in`; boolean state, ON at/above `high`, OFF at/below `low`, hold inside |
| Low-pass filter | Numeric `in`; elapsed-time smoothing with `timeConstantMs`, initializes on first valid sample |
| Rising-edge counter | Boolean `in`, `reset`; numeric count of observed rising edges, saturates at `maxCount` |
| NOT | `in` |
| AND / OR / XOR | `a`, `b`; all input qualities must be Good |
| TON | `in`; output becomes true after the input remains true for the delay |
| TOF | `in`; initially OFF, remains true for the delay after a falling input |
| Pulse | `in`; a rising edge starts a fixed pulse; active pulses cannot be retriggered |
| Debounce | `in`; either new value must remain stable for the delay; initial output is false |
| Latch | `set`, `reset`; reset dominates |
| Interlock | `in`, `permit`; false permit produces an inhibited result |
| Auto / Manual | `auto`, `manual`, `isAuto`, `permit`; Manual cannot bypass permit |
| JS / TS script | `a`, `b`; pure boolean function with explicit monotonic time; at most two per graph |
| Output | `in`; maps the result to a bound signal, without sending a command |

Missing, incorrectly typed, nonfinite, or non-Good input samples propagate `Bad`, `value: null`, and a reason; they never become a fabricated false reading. Stateful blocks reset their volatile state on invalid inputs. False permit produces `Bad` with `Interlock is not permitted`. This inhibits an output intent; it does not assert that an actuator moved to its safe state. Device watchdogs and independent protections remain necessary. The LED-specific physical policy is separate from the pure engine.

Numeric and boolean connections are validated in drafts as well as prepared revisions. No implicit numeric/boolean conversion is permitted. Division by zero and arithmetic overflow produce `Bad` and inhibit downstream output. Hysteresis requires finite `low < high`, starts false, and resets false on invalid input or a new engine. An invalid result anywhere in the calculated output set revokes the graph before any output intent from that tick is dispatched. This preflight is not atomic multi-actuator delivery: a later transport/journal failure may still occur after earlier valid commands have been accepted.

The numeric representation is JavaScript float64, with ordinary IEEE-754 rounding; it is not an exact integer/currency type. Exact int64/uint64 strings cannot bind to numeric blocks. Scripts retain boolean ports/results. Output blocks and device commands remain boolean. All node traces display numeric values directly. See [numeric logic profile](numeric-logic.md) for current runtime and catalog limits.

## HMI scene contract

Schema version 1 contains width, height, and up to 512 items. Supported kinds are `label`, `indicator`, `value`, `button`, and `group`. Value items bind to float64 signals and display read-only numbers; indicators and buttons remain boolean. Bound elements reference catalog signals; buttons require an output. Coordinates are finite, dimensions are bounded to 1–10,000, and parent groups must exist without cycles. Unknown fields, executable scripts, raw SVG, and external asset definitions are rejected. User text is rendered through React text nodes.

Undo/redo stores up to 100 past document snapshots by default. Reads and writes are copied; a new edit clears redo. Canonical JSON comparison ignores object-key order while preserving array order, avoiding false changes after PostgreSQL JSONB round trips.

## API and persistence

All endpoints require the existing authenticated session and mutation Origin/CSRF checks.

| Route under `/api/v1` | Behavior |
|---|---|
| `GET/POST /projects/:id/graphs` | Cursor-paged metadata list or empty graph draft creation |
| `GET/POST /projects/:id/screens` | Cursor-paged metadata list or empty HMI draft creation |
| `GET/PUT /graphs/:id` | Read or replace a draft |
| `GET/PUT /screens/:id` | Read or replace a draft |
| `POST /graphs/:id/simulate` | Up to 100 ordered virtual-time input snapshots; no device writes |
| `GET/POST /graphs/:id/revisions` | List or prepare immutable revisions |
| `GET/POST /screens/:id/revisions` | List or prepare immutable revisions |

PUT and revision preparation require a quoted `If-Match` draft revision. Missing preconditions return 428, stale revisions 412, and invalid documents/bindings 422. Unknown resources return 404. Draft writes and their audit records commit atomically under a row lock. Signal references cannot cross project boundaries. Request bodies retain the 64 KiB API limit, which may constrain a verbose document before its item-count limit.

Prepared revisions contain the document, name, actor, timestamp, and SHA-256 of canonical JSON containing name/document. Preparing the same revision is idempotent. Later draft edits cannot overwrite a prepared revision; database triggers reject update/delete of revision rows. Database administrators are not part of this immutability threat model. Lists return up to 20 revisions, with `nextBefore` pagination. Prepared is distinct from Active; activation is an explicit, audited operation. Revision switches reset volatile state; retained-state migration remains pending.

Application migration 002 adds document/revision tables. The migration runner verifies the complete applied checksum prefix and upgrades version 1 in place; it does not alter the previously applied migration. Integration tests verify upgrade preservation, concurrent save conflicts, immutable history, cross-project binding rejection, audit rollback, and simulation isolation.

Graph interaction uses the pinned [React Flow library](https://reactflow.dev/learn), while validation and execution remain independent domain code. The HMI uses native SVG. All assets needed by these editors are local dependencies; no CDN or external font is required.

## Server activation

Prepared graph revisions can now be activated against running virtual devices from the editor. The operator must supply a reason. The active revision and state remain visible after reopening the graph, while editing continues against its draft. See [runtime execution and revision-switch contracts](runtime.md#prepared-graph-execution). This does not enable physical profiles or convert the isolated five-second simulation bench into a device runtime.

## Operator screens

Choose **Operate revision N** from a prepared screen to open an immutable scene with current values. Later edits to its draft do not change that scene. Indicators include ON/OFF/No data and quality text as well as color. Buttons open the existing reasoned ON/OFF command panel; they never publish MQTT directly. The same backend ownership, interlock, freshness, revision, and journal checks apply, including rejection while a graph owns the output.

Polling has at most eight concurrent requests, a two-second request deadline, and no overlapping rounds. Each round waits one second before the next. Failed reads retain the last displayed value with Disconnected quality. Independently, a Good browser sample becomes Stale after three seconds without a successful refresh (checked every 500 ms). Controls are disabled unless displayed quality is Good; the server still rechecks authority. This bounded polling implementation is for the current simulation profile, not the eventual high-volume subscription architecture.

Equipment controls are also exposed as normal, touch-sized HTML buttons below the scene. The SVG canvas scrolls inside its own container on phones; the page itself does not require horizontal scrolling. Runtime signals are simulation-only until physical commissioning is implemented. Screen publication currently means selecting a prepared immutable revision; persistent operator landing-screen assignments and faceplates remain future work.

## Prepared revision comparison and draft restoration

Both graph and HMI revisions can be compared with another prepared revision or the current saved draft. Comparisons show structural JSON pointer paths, change kind, and before/after values. Object key order is ignored; array order remains meaningful, including screen item stacking order. At most 200 changes are returned, with the total count and an explicit truncation flag. This is a structural review, not a proof of equivalent process behavior.

`GET /api/v1/{graphs|screens}/:id/revisions/:revision/compare?target=draft|REVISION` requires project ownership. Comparing the draft additionally requires its current `If-Match` revision. Both prepared sources are checked against their stored SHA-256 checksum. A stale draft returns 412, a missing precondition 428, a missing/foreign document 404, and an invalid stored checksum 422.

`POST /api/v1/{graphs|screens}/:id/restore` takes `{ "revision": 2, "reason": "Restore reviewed behavior" }` with the saved draft's `If-Match` header. The server locks the draft, verifies ownership/checksum/schema/current signal bindings, copies the prepared name/document to a new monotonically numbered draft, and writes the restore audit event in the same transaction. Audit failure rolls back the draft. Concurrent requests cannot silently overwrite the winning revision.

Restoration never modifies an immutable prepared snapshot, activates a graph, changes its running generation, sends an equipment command, or restores live timer state. The restored draft must be separately prepared and explicitly activated to change running logic. An unprepared draft being replaced is not automatically archived: prepare any valid work that must remain recoverable before restoration. General draft autosave history and whole-project rollback remain separate future work.

Filter/counter parameters, initialization, reset, invalid-input behavior and sampling limitations are specified in [numeric logic](numeric-logic.md#stateful-numeric-blocks). Their state is not retained across activation or restart.
