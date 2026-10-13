# Numeric logic engineering profile

This partial M2 increment adds typed numeric ports, finite constants, four arithmetic operations, strict greater/less comparisons, hysteresis, a low-pass filter and a bounded rising-edge counter, PID and time proportioning to the existing graph editor, pure simulation engine and headless task. It does not complete retentive/hardware counters, arbitrary filters, formulas with arbitrary numeric scripts, schedules, physical numeric device drivers or numeric actuators.

## Use through the web

Create a graph with a Numeric constant, Hysteresis and a bound LED Output. Configure a constant of 12 and a band of 5 to 10. Connect the numeric constant to hysteresis `in`, then its boolean output to the LED `in`. Save and simulate: the numeric trace reads 12 and the output is ON. Prepare and activate only after starting the device runtime. The same audited command journal, output owner and acknowledgement rules apply as for boolean graphs. A changed constant in a new revision resets hysteresis when activated.

An arithmetic branch takes `a` and `b` ports and produces a number. Connect its result through a comparison or hysteresis before a boolean output. Direct number-to-output connections are rejected, including in incomplete drafts. Properties, JSON editing, revision comparison/restoration and touch/keyboard connection controls use the same document contract. Port tooltips identify the expected type. Hysteresis properties explain both inclusive boundaries and state reset.

## Numeric inputs and current delivery boundary

The catalog permits boolean input/output signals and float64 inputs; numeric outputs remain prohibited. Devices can register a Virtual thermal process with a boolean heater and float64 temperature sensor. See [virtual process operation](virtual-process.md). The ordinary LED profiles still create a single boolean output.

`analog` nodes bind to the same project's float64 signals. The authenticated simulation endpoint accepts numeric samples, including 0 and 1, without boolean coercion; null or a mismatched boolean sample produces Bad quality. Browser controls can simulate these inputs. The thermal profile can also supply live numeric inputs to a prepared graph. Other numeric hardware/third-party driver bindings remain unsupported: activation returns 422 `UNSUPPORTED_DRIVER` before pausing or transferring the current graph. Internal numeric constants/calculations/comparisons can also command existing boolean LED outputs.

`GraphTask` additionally validates every numeric sample as finite and Good with a stable device boot session. A bad sample faults the task and revokes its output authority. No automatic restart or fabricated zero occurs. All calculated outputs are checked before the first command intent in that tick. This is a preflight guarantee, not atomic delivery across devices. Device watchdogs remain responsible for the LED safe-state transition after authority loss.

## Semantics and verification

Values are finite float64 numbers. Arithmetic overflow and any division by zero produce Bad with a reason; they do not saturate or silently convert. Comparisons are strict, so equality is false for both greater and less. Hysteresis is inclusive at its thresholds, holds inside its band, starts OFF, and resets OFF on invalid input or new task creation. This engineering default is not a universal process-safe state.

The API rejects wrong catalog types, cross-project bindings, numeric outputs and unsupported integer catalog types. The kernel rejects graph type conflicts and nonfinite constants. Docker tests cover arithmetic results, boundaries, invalid values, overflow, hysteresis state/reset, task revocation, preflight across multiple outputs, database upgrade, numeric API simulation, MQTT command verification and rejection without disturbing the active revision. Chromium exercises numeric properties, typed wiring rejection, simulation traces, controlled activation and the phone layout. Physical analog inputs and hardware acceptance remain untested.

## Stateful numeric blocks

`filter` takes numeric `in` and requires an integer `timeConstantMs` from 1 to 86,400,000. Its first valid sample initializes the result directly. Later samples use `alpha = 1 - exp(-elapsedMs / timeConstantMs)` and the convex combination `(1 - alpha) * previous + alpha * current`. The current sampled input applies to this update; this is a sampled smoothing rule, not a reconstruction of unobserved signal changes. Equal timestamps keep the previous result. A long interval approaches the current input without replaying intermediate ticks. The implementation uses `expm1` and avoids subtracting opposite-sign extreme inputs. Nonfinite results are Bad.

`counter` takes boolean `in` and `reset`, returns a number, and requires an integer `maxCount` from 1 to 9,007,199,254,740,991. It counts observed OFF-to-ON transitions, starts at zero and uses its first valid input only to establish the previous level. Reset takes priority and keeps tracking the input level, so releasing reset while input is ON does not invent an edge. The count holds at its configured limit instead of wrapping. Pulses between graph evaluations can be missed; this is not a hardware pulse counter.

Both blocks propagate invalid input as Bad and clear their internal state. The next valid filter sample initializes its value; the next valid counter sample establishes its level with a zero count. A new engine, graph activation or revision switch also starts fresh. No state is retained across restart. Reset cannot bypass invalid counter input. Downstream boolean outputs retain the common whole-output preflight, ownership and journal rules.

Both blocks are available in the web block selector, Properties, JSON editor and simulation trace. A test graph delays a rising edge, counts it, filters the count, compares it with 0.5 and commands a virtual LED. Docker tests verify the virtual-time trace, immutable saved revision and actual MQTT acknowledgement.

PID, mixed controller ports, normalized duty conversion, tuning boundaries and Manual/Auto semantics are specified in [PID control](pid-control.md).
