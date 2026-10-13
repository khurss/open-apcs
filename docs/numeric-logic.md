# Numeric logic engineering profile

This partial M2 increment adds typed numeric ports, finite constants, four arithmetic operations, strict greater/less comparisons, and hysteresis to the existing graph editor, pure simulation engine and headless task. It does not complete PID, filters, counters, formulas with arbitrary numeric scripts, schedules, numeric device drivers or numeric actuators.

## Use through the web

Create a graph with a Numeric constant, Hysteresis and a bound LED Output. Configure a constant of 12 and a band of 5 to 10. Connect the numeric constant to hysteresis `in`, then its boolean output to the LED `in`. Save and simulate: the numeric trace reads 12 and the output is ON. Prepare and activate only after starting the device runtime. The same audited command journal, output owner and acknowledgement rules apply as for boolean graphs. A changed constant in a new revision resets hysteresis when activated.

An arithmetic branch takes `a` and `b` ports and produces a number. Connect its result through a comparison or hysteresis before a boolean output. Direct number-to-output connections are rejected, including in incomplete drafts. Properties, JSON editing, revision comparison/restoration and touch/keyboard connection controls use the same document contract. Port tooltips identify the expected type. Hysteresis properties explain both inclusive boundaries and state reset.

## Numeric inputs and current delivery boundary

The catalog now permits boolean input/output signals and float64 inputs. Migration 009 preserves existing data and prohibits numeric output signals. The existing device registration workflow still creates a single boolean LED output; there is no numeric device commissioning screen or ingestion driver yet. Do not edit the production database to make a hardware driver appear supported.

For upcoming numeric drivers, `analog` nodes bind to the same project's float64 signals. The authenticated simulation endpoint accepts numeric samples, including 0 and 1, without boolean coercion; null or a mismatched boolean sample produces Bad quality. Browser input controls are available when such catalog bindings exist. This path is tested using isolated catalog fixtures. API preparation can preserve those graphs, but live activation rejects numeric input nodes with 422 `UNSUPPORTED_DRIVER` before pausing or transferring the currently active graph. Internal numeric constants/calculations/comparisons can execute now and command existing boolean LED outputs.

`GraphTask` additionally validates every numeric sample as finite and Good with a stable device boot session. A bad sample faults the task and revokes its output authority. No automatic restart or fabricated zero occurs. All calculated outputs are checked before the first command intent in that tick. This is a preflight guarantee, not atomic delivery across devices. Device watchdogs remain responsible for the LED safe-state transition after authority loss.

## Semantics and verification

Values are finite float64 numbers. Arithmetic overflow and any division by zero produce Bad with a reason; they do not saturate or silently convert. Comparisons are strict, so equality is false for both greater and less. Hysteresis is inclusive at its thresholds, holds inside its band, starts OFF, and resets OFF on invalid input or new task creation. This engineering default is not a universal process-safe state.

The API rejects wrong catalog types, cross-project bindings, numeric outputs and unsupported integer catalog types. The kernel rejects graph type conflicts and nonfinite constants. Docker tests cover arithmetic results, boundaries, invalid values, overflow, hysteresis state/reset, task revocation, preflight across multiple outputs, database upgrade, numeric API simulation, MQTT command verification and rejection without disturbing the active revision. Chromium exercises numeric properties, typed wiring rejection, simulation traces, controlled activation and the phone layout. Physical analog inputs and hardware acceptance remain untested.
