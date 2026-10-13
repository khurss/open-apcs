# Single-output timed sequences

Status: initial M2 sequence behavior. The graph editor, saved/prepared revisions, simulation and headless graph runtime share the same kernel. This is not an SFC implementation, a multi-device recipe transaction or a safety function.

## Definition

A `sequence` block has boolean `start`, `cancel` and `permit` inputs and one boolean output. Its `sequence` settings contain `maxIntervalMs` (integer 100–10,000) and 1–16 ordered steps. Every step has a nonblank label of at most 64 characters, a boolean requested value and an integer duration of 100–86,400,000 ms. Unknown fields and unconnected or incorrectly typed ports are rejected when preparing the graph. Drafts may retain unconnected ports for editing.

The editor supports step labels, durations, ON/OFF values, insertion, removal and reordering. Undo/redo, JSON editing, optimistic draft saves and immutable prepared revisions apply normally. Simulation exposes `Idle`, `Running`, `Completed` or `Aborted`, with a zero-based step index and label while running. The Properties panel shows this as a human-readable one-based index.

## Execution contract

- A new execution starts Idle with output OFF. An initially high Start does not launch a sequence. It must first observe Start OFF while Permit is ON and Cancel is OFF, followed by Start ON under those same conditions.
- While Running, start edges are consumed without queuing or restarting. Holding Start ON after completion does not repeat the sequence. A new eligible OFF-to-ON transition is required.
- The first step begins at the accepted Start observation. Its duration starts then. At or after the duration boundary, the next observed graph cycle advances at most one step and starts that step's full duration at that observation. Missed steps are never replayed in a burst.
- After the last step, the sequence is Completed and requests OFF. Completion describes evaluation of the requested sequence, not verified completion of physical operations.
- Cancel ON or Permit OFF takes precedence over normal start/advance. It immediately requests OFF and changes a Running sequence to Aborted. It clears eligibility to start, including a low Start observed while disabled. Restoring Permit or releasing Cancel never resumes or starts an interrupted sequence.
- Monotonic time must be finite, nonnegative and nondecreasing. While Running, a gap strictly greater than `maxIntervalMs` latches a fault. The deadline check precedes cancellation; cancellation cannot disguise an overdue execution. Idle downtime alone does not fault.
- Invalid upstream quality latches a sequence fault. The graph reports Bad and its existing all-output preflight revokes authority without dispatching another graph intent. A recovered input cannot clear the fault. A newly authorized graph execution creates fresh state and again requires an observed eligible start edge.
- Process death, graph stop and revision activation do not retain progress or resume steps. Timers measure monotonic elapsed time, independently of weekly-schedule wall-clock policies.

Every requested output goes through the existing single-writer, interlock, command-journal and lease path. There is no bypass for a sequence. The graph requests changes rather than retransmitting every scan. A command/acknowledgement failure still faults the task and does not cause a recipe-style retry. Independent device lease expiry and hardware protection remain required.

## Timing and scope limits

Durations refer to **requested values**, not measured actuator dwell or acknowledgement time. Network/dispatch delay and graph cadence can extend or shorten physical dwell relative to this software trace. Choose durations and maximum intervals appropriate for the graph period, including the one-second minimum for graphs containing scripts. This block is unsuitable for operations requiring precise physical pulse widths or confirmation-gated steps.

The initial profile is a non-retentive, single-output sequence. Conditional transitions, explicit equipment-completion inputs, per-step fault recovery, branching, parallel steps, persistent execution journals, parameterized recipes, operator batch selection, multi-output partial-failure handling and full SFC remain pending. A timer pattern does not satisfy those future acceptance criteria.

Docker checks cover startup/retrigger behavior, disabled/cancelled starts, ordered durations, delayed observations without catch-up, clock/deadline and quality faults, validation bounds, graph diagnostics, simulator isolation and the real MQTT/command journal. Browser checks create/edit/save/reload the block and simulate a delayed ON/OFF/ON pattern to completion. Physical timing and HIL are not claimed.
