# Thermal recipe simulation

This M2 increment provides versioned parameters and durable execution history for
an isolated, server-side thermal chamber. It does not bind recipes to catalog
signals, graph outputs, MQTT, or physical equipment. General recipes, custom steps,
branching, SFC, retentive execution and real-device recipe control remain pending.

## Operator workflow

Open a project and choose **Thermal recipes**, or use **Recipes** in navigation.
The new-recipe form contains a working demo: target 22 C, hold 5 seconds, heating
timeout 60 seconds. Publish a version, then start its simulation. Publishing does
not start execution. Edit a selected version to publish a new immutable version;
a concurrent edit requires reloading and selecting the latest version.

Each run copies the exact published parameters. Editing, publishing or navigating
away cannot change them. One simulation may run per project. Cancellation, permit
loss and bad quality terminate a run with the virtual heater OFF and an event.
Fault injection buttons affect this simulation only. A stopped run never resumes;
starting another run always creates a new chamber initially at 20 C.

## Execution contract

- Parameters: target 21–35 C; integer hold 1–3600 seconds; integer heating timeout
  1–600 seconds. Unknown properties and nonfinite values are rejected.
- States: Running, Completed, Aborted. Steps: Heating, Holding, Finished.
- Model: 20 C ambient, 40 C heated equilibrium, 20-second time constant. The
  elapsed interval uses the previous heater state. At the target the Holding
  timer starts; a simple sampled thermostat switches heat below the target.
- Holding is elapsed timed thermostat operation, **not a guarantee of continuous
  temperature dwell within a tolerance**. Completion turns heat OFF; no cooling
  step is provided. An unreachable target within the configured timeout aborts.
- The server schedules a tick after each transaction plus 500 ms. Backward time
  or a gap over 2500 ms aborts, rather than replaying missed steps. It is not a
  real-time or safety-certified control loop. Wall-clock corrections can abort.
- A database advisory lease permits one simulator per application schema; row locks
  serialize ticking and cancellation. Startup and graceful shutdown abort active
  runs. After an abrupt stop, restart marks them Aborted before ticking. During a
  server outage, the last stored state is historical, not evidence of execution.
- Each tick persists the sampled state. Step transitions, start, completion,
  cancellation and faults have durable run events and audit entries in the same
  transaction. No physical command records are created.
- Preview limits: 100 recipe versions and 100 runs per project; lists return all
  records within these bounds. No deletion or retention cleanup is provided yet.
  The worker processes at most 100 active runs per tick; larger scale is untested.

## API

All routes require the existing session, owner authorization and mutation CSRF.

| Route under `/api/v1/projects/:id` | Contract |
| --- | --- |
| GET `/recipes` | Published versions, newest first |
| POST `/recipes` | `{name, parameters}` creates v1; add `recipeId` and `expectedRevision` to publish the next version |
| GET `/recipe-runs` | Newest runs with frozen parameters, latest state and events |
| POST `/recipe-runs` | `{recipeId, revision}` starts that exact version; 409 if a run is active |
| POST `/recipe-runs/:runId/cancel` | `{}` cancels; `{cause:"permit"}` or `{cause:"quality"}` injects a terminal simulation fault |

A stale publication returns 412. Wrong-project versions and foreign-owner data
return 404. Published versions are protected against UPDATE/DELETE in PostgreSQL.
There is no automatic retry of a start after an ambiguous HTTP response: inspect
the execution journal before starting again.

## Acceptance

Docker domain tests cover validation, parameter snapshot isolation, elapsed model
progression, completion, heat timeout, permit/quality faults and scheduling gaps.
PostgreSQL integration covers version protection, concurrent starts, stale edits,
ownership, exact version binding, journals, headless ticks, restart and exclusive
simulator ownership. Chromium covers publishing, frozen runs, leaving the page,
completion, cancellation and fault injection, plus phone overflow checks.
The complete repository Docker gate and evidence are recorded in `tdd-log.md`.
