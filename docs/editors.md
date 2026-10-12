# Editor documents and isolated logic simulation

This increment provides basic graph and HMI editing, durable drafts, immutable prepared revisions, and isolated simulation. Prepared graphs also execute in the private simulation worker. Physical outputs, autonomous remote gateways, and the complete M1 release remain pending.

## Web workflow

Register a project and a virtual LED device. Open **Logic**, create a graph, and start with **LED template**, or add blocks individually. Move blocks on the canvas, connect their handles, and configure the selected block in Properties. A keyboard/touch connection form is also available. Delete connections there, or select an edge on the canvas and use Delete. Delete a selected block through Properties; its incident edges are removed.

Save the draft before simulation or revision preparation. The simulation bench runs 51 samples from 0 to 5000 ms in 100 ms increments. Input blocks accept OFF, ON, or simulated disconnection. Results annotate the graph and list output values/reasons. Simulation uses a fresh engine and has no dependency on the command journal or hardware drivers.

Open **Screens** to arrange labels, indicators, buttons, and groups on an SVG scene. Configure signal bindings, coordinates, dimensions, and parent groups. Drag a group to move its descendants; coordinates are absolute scene coordinates. Arrow keys move a selected item by 10 px, or 1 px with Shift. Removing a group ungroups direct children. Buttons are design elements in this increment; they do not dispatch commands. Indicators explicitly show that live data is unavailable.

Both editors provide bounded undo/redo and a JSON document editor. JSON is a portable data representation; it is not JavaScript/TypeScript script execution or Structured Text support. Saved scenes and graphs survive API/browser restarts. Navigation prompts before discarding modified document state. A prepared revision does not activate equipment. Complex editing is oriented toward desktop/tablet; the phone interface provides controls and an internally scrollable HMI canvas.

## Boolean graph contract

Schema version 1 contains `nodes` and `edges`. Node IDs and signal bindings are stable strings; API signal bindings must resolve to the owning project's catalog. Each edge connects a source block to a named target input port. Output blocks cannot be edge sources. One edge may feed each input port; fan-out is supported. A graph may contain at most 256 nodes and 1024 edges. Timers accept integer delays from 0 to 86,400,000 ms.

Draft validation permits unconnected input ports so incomplete work can be saved. Execution and revision preparation require all declared ports to be connected. All modes reject duplicate IDs, unknown fields/kinds/versions, cycles, invalid coordinates, and multiple output blocks bound to one signal. Cyclic feedback is not supported; latch state is internal to the block. These limits are an initial engineering profile, not the final scale target.

The engine copies its input graph, uses a deterministic topological order, and evaluates one synchronous snapshot per tick. Equal graphs, inputs, time sequences, and initial state produce equal results. Time must be finite, nonnegative, and nondecreasing. The engine uses no wall clock or I/O and does not perform catch-up ticks. A new engine resets all state; retained-state migration remains future work.

| Block | Ports and behavior |
|---|---|
| Constant | Boolean parameter; no inputs |
| Input | Read one boolean signal sample |
| NOT | `in` |
| AND / OR / XOR | `a`, `b`; all input qualities must be Good |
| TON | `in`; output becomes true after the input remains true for the delay |
| TOF | `in`; initially OFF, remains true for the delay after a falling input |
| Pulse | `in`; a rising edge starts a fixed pulse; active pulses cannot be retriggered |
| Debounce | `in`; either new value must remain stable for the delay; initial output is false |
| Latch | `set`, `reset`; reset dominates |
| Interlock | `in`, `permit`; false permit produces an inhibited result |
| Auto / Manual | `auto`, `manual`, `isAuto`, `permit`; Manual cannot bypass permit |
| Output | `in`; maps the result to a bound signal, without sending a command |

Missing, nonboolean, or non-Good input samples propagate `Bad`, `value: null`, and a reason; they never become a fabricated false reading. Stateful blocks reset their volatile state on invalid inputs. False permit produces `Bad` with `Interlock is not permitted`. This inhibits an output intent; it does not assert that an actuator moved to its safe state. Device watchdogs and independent protections remain necessary. The LED-specific physical policy is separate from the pure engine.

## HMI scene contract

Schema version 1 contains width, height, and up to 512 items. Supported kinds are `label`, `indicator`, `button`, and `group`. Bound elements reference catalog signals; buttons require an output. Coordinates are finite, dimensions are bounded to 1–10,000, and parent groups must exist without cycles. Unknown fields, executable scripts, raw SVG, and external asset definitions are rejected. User text is rendered through React text nodes.

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
