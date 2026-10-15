# Thermal recipes: isolated model and virtual MQTT

This M2 increment provides versioned parameters and durable execution history for
an isolated server-side model or a registered virtual thermal chamber over MQTT.
The MQTT path uses measured telemetry and the existing durable command journal.
Bindings to other device profiles, branching, SFC, retentive execution and
physical recipe control remain pending.

## Operator workflow

Open a project and choose **Thermal recipes**, or use **Recipes** in navigation.
The new-recipe form contains a working demo: target 22 C, hold 5 seconds, heating
timeout 60 seconds. **New multi-step demo** creates an editable Heat → Hold → Cool
program. Add, remove and reorder up to 16 steps. **Use step editor** explicitly
converts a legacy draft into Heat and Hold steps for the next publication; existing
versions are never rewritten. Publish a version, then start its simulation. Publishing does
not start execution. Edit a selected version to publish a new immutable version;
a concurrent edit requires reloading and selecting the latest version.

Each run copies the exact published parameters. Editing, publishing or navigating
away cannot change them. One simulation may run per project. Cancellation, permit
loss and bad quality terminate a run and record an event. In isolated mode the
model heater becomes OFF; in MQTT mode control authority is revoked, without
claiming a verified OFF acknowledgement.
Fault injection buttons affect this simulation only. A stopped run never resumes;
isolated runs start at 20 C. MQTT runs require an explicitly started simulator
with Good telemetry and an OFF heater; they use its measured temperature.

## Isolated model execution contract

- Legacy parameters: target 21–35 C; integer hold 1–3600 seconds; integer heating timeout
  1–600 seconds. Unknown properties and nonfinite values are rejected.
- States: Running, Completed, Aborted. Legacy steps: Heating, Holding, Finished.
  Version-2 programs also support Cooling and persist a zero-based stage index.
- Model: 20 C ambient, 40 C heated equilibrium, 20-second time constant. The
  elapsed interval uses the previous heater state. At the target the Holding
  timer starts; a simple sampled thermostat switches heat below the target.
- Holding is elapsed timed thermostat operation, **not a guarantee of continuous
  temperature dwell within a tolerance**. Completion turns heat OFF. Legacy recipes
  have no cooling step; version-2 programs support explicit passive cooling. An
  unreachable target within the configured timeout aborts.
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

## Ordered thermal programs (parameter schema version 2)

Legacy `{targetC, holdSeconds, maxHeatSeconds}` parameters remain supported without
migration. New programs use `{schemaVersion: 2, steps: [...]}`; this schema version
is independent of the recipe's publication revision. Programs have 1–16 ordered
steps; every step has a nonblank `name` of at most 64 characters.

| Kind | Fields and limits | Completion and output |
| --- | --- | --- |
| `heat` | `targetC`: 21–35; integer `timeoutSeconds`: 1–600 | At or above target; heater ON below target |
| `hold` | `targetC`: 21–35; integer `durationSeconds`: 1–3600 | Elapsed duration from step entry; thermostat ON below target |
| `cool` | `targetC`: 20.5–35; integer `timeoutSeconds`: 1–600 | At or below target; heater always OFF |

Hold does not wait to reach its target. Add Heat before Hold when that is desired.
Cooling is passive toward the model's 20 C ambient; the lower bound avoids an
asymptotic, unreachable 20 C target. There is no cooling actuator.

Only one transition is allowed per tick. Each next-step timer begins at the
observation that enters it; delayed observations never skip steps or carry unused
time forward. An already satisfied heat/cool condition advances on the next tick.
A reached target wins over a simultaneous timeout. Timeout events identify the
step number, name and heating/cooling cause. Consecutive steps of the same kind
still generate distinct journal transitions. Completion, cancellation and quality,
permit or clock faults always turn the virtual heater OFF.

Publishing and starting clone the entire ordered program. The editor and run
journal show the frozen steps; later versions cannot reorder a running program.
Startup continues to abort both legacy and version-2 active snapshots. Ordered
programs use the existing JSON parameters and snapshots with immutable-version
and backup protections. Migration 17 adds frozen MQTT bindings and control
evidence; migration 18 adds the idempotent demo installation manifest.

## Virtual MQTT execution contract

In **Recipes**, use **Install MQTT recipe demo**. This idempotently installs a
separate **Recipe chamber**, **MQTT thermal demo** version 1 (Heat 22 C, Hold 5 s,
Cool 21 C), and prepared **Recipe chamber overview** with readings and a trend.
Select the chamber as **Recipe execution target**, start its simulator, then
start the published version. Open the prepared screen to watch project recipe
status and the current step. Installation never starts a device or recipe.

- The API resolves and freezes device, temperature signal, output signal and
  project revision. Cross-project and non-thermal/physical bindings are rejected.
- Execution runs in the private runtime worker every 250 ms after the preceding
  cycle. Temperature is published by the independent virtual process at 1 Hz.
  The recipe does not integrate a second thermal model. A 2.5 s scheduling gap
  or independent execution watchdog revokes control; this is not hard real time.
- The output owner becomes `recipe:<runId>`. Manual commands and graph activation
  cannot take it. A graph-owned output or unresolved command prevents activation.
  Failed activation does not stop an unrelated graph.
- Each changed heater intent goes through the existing journal/outbox with a
  2 s TTL. Only Verified commands advance command progress. Failure, unknown
  outcome or verification deadline aborts; commands are never blindly retried.
- Completion requires an explicit final OFF command and Verified journal evidence.
  Until then the run remains Running with control phase Finishing. Successful
  completion stops the device runtime; another run requires an explicit restart.
- Bad/stale/disconnected telemetry, boot changes, project revision changes on a
  command, cancellation, persistence failure or worker shutdown abort the run and
  revoke the output owner/session. **Revocation is not verified OFF**. The UI
  distinguishes requested heater state from command evidence and live telemetry.
- A run heartbeat older than 5 s is marked Aborted by the server. Worker/API
  restarts do not rearm devices or resume recipes. Conditional, row-locked writes
  cannot revive a terminal run. Stored state during an outage is historical.
- The operator screen displays the latest/active **project-level** MQTT run in a
  status panel; this is not yet a freely placed per-equipment recipe widget.
- Existing runtime limits (16 active devices), one active recipe per project and
  100 versions/runs per project apply. No physical equipment is exercised.

## API

All routes require the existing session, owner authorization and mutation CSRF.

| Route under `/api/v1/projects/:id` | Contract |
| --- | --- |
| GET `/recipes` | Published versions, newest first |
| POST `/recipes` | `{name, parameters}` creates v1; add `recipeId` and `expectedRevision` to publish the next version |
| GET `/recipe-runs` | Newest runs with frozen parameters, latest state and events |
| POST `/recipe-runs` | `{recipeId, revision, deviceId?}` starts that version; omitted device means isolated mode; 409 if active or activation conflicts |
| POST `/recipe-demo` | `{}` installs or returns a dedicated chamber, published recipe and prepared HMI in this project; never arms control |
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
Additional tests cover measured execution, verified final OFF, command failures,
watchdog/cancellation races, graph/manual exclusion, actual MQTT socket loss and
private worker death. Chromium installs and runs the MQTT demo, observes it in
the HMI, and cuts the fixture MQTT transport to check a latched abort.
The complete repository Docker gate and evidence are recorded in `tdd-log.md`.
