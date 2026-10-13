# Activated graph diagnostics

The Server execution panel exposes the last calculation of the **activated revision**, separately from the draft canvas and its isolated simulation. Open Last server evaluation to inspect block names/types, calculated values, quality at calculation, sequence progress or an inhibition reason. The panel shows the active revision, cycle number, UTC calculation timestamp and count of commands still tracked as pending by that task.

The owner-authenticated graph runtime response includes `pending` and a nullable `evaluation` object containing `at`, `cycle`, `blocks` and `result`. Block metadata comes from the validated immutable revision captured at activation, not a later edited draft. A snapshot is limited by the graph's existing 256-node/1024-edge bounds. The table initially displays 50 nodes and can reveal more up to the complete graph. No script source or device credentials are included.

## Meaning and freshness

These are calculated requests, **not actuator feedback**. A calculation can precede command dispatch, remain pending, or fail an output preflight. The command journal and current signal feedback remain the source of delivery and observed-state evidence. Sequence Completed describes completion of its requested schedule, not proof that every physical step executed.

The snapshot is published only after asynchronous evaluation finishes while the task is still active. A late script result after stop, pause or timeout cannot replace it. Returning status clones the snapshot, so an observer cannot mutate runtime state.

An unstarted task has no evaluation. Stopped/faulted tasks may retain their last evaluation in memory for inspection, explicitly marked historical. Restarting the worker loses that volatile diagnostic snapshot; it does not restore authority or replay commands.

The browser polls without overlapping requests, with a three-second request deadline. Failed reads remove displayed values and show Status unavailable. A successful response is labelled Recent calculation only when the task is running and the timestamp is between zero and three seconds old relative to the browser clock. Older or future timestamps and inactive tasks are labelled Historical or overdue calculation. This conservative display check is not a real-time guarantee or a replacement for device quality/lease checks; differing browser/server clocks can also prevent a Recent label.

There is no historical trace database, breakpoint, force-value operation, or direct live-edit action in this view. Prepared-revision activation remains an explicit audited operation. Future streaming diagnostics and incident capture must preserve the same revision and freshness boundaries.

## Verification

Docker task tests cover isolated timestamped results, retained historical state and late asynchronous completions after stop/deadline. PostgreSQL/MQTT integration checks sequence progress over private runtime IPC, owner authentication and unchanged active labels after editing the draft. Browser checks verify calculated values, disappearance on polling failure, recovery, and historical labelling after stop.

## Monotonic cadence and timing evidence

Graph execution now schedules start times on a monotonic grid. A 100 ms period with a 30 ms evaluation starts at 0, 100, 200 ms instead of drifting to 0, 130, 260 ms. Work never overlaps. Slots already elapsed at completion are skipped; there is no catch-up burst. Resuming a paused task establishes a new grid without counting the intentional pause as overload. Scripts retain their minimum 1000 ms period and the existing 2000 ms execution deadline.

The authenticated runtime response adds nullable `timing`: effective `periodMs`, `starts`, `skipped`, `maxStartDelayMs`, `maxExecutionMs`, `lateStarts` (over 50 ms), and a bounded `startDelay` histogram summary. These bounded counters cover the task lifetime, including warmup; an unstarted task has no timing. Start delay is measured against the scheduled monotonic deadline; execution includes reads, evaluation and command submission. The summary provides nearest-rank p50/p95/p99 upper bounds using the same 1 ms buckets and overflow maximum as gateway diagnostics. Maxima remain visible separately from percentile evidence. This instrumentation does not turn the Node/Linux runtime into a hard real-time controller.
