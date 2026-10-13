# PID and time-proportioning engineering profile

This simulator-tested M2 increment provides a normalized parallel PID block, a boolean time-proportioning block and a virtual thermal template. Both execute in the existing headless graph task and use its typed ports, quality propagation, output preflight and durable command path. This is an explicitly defined software profile, not a claim of IEC 61131-3 conformance, validated physical tuning or a safety function.

## Web workflow

Register and start a Virtual thermal process. Create a graph in Logic, select its Template device, then choose PID thermostat template. The preset uses a 24 C setpoint, Kp 0.15, Ki 0.02, Kd 0, a 100 ms derivative filter, a 2500 ms maximum calculation interval and a 2000 ms duty window. These are parameters for the fixed simulator, not recommended values for arbitrary equipment. Review all bindings and parameters, save, simulate, prepare and explicitly activate the revision.

The template supplies numeric temperature/setpoint/manual-duty inputs and boolean Auto/Enable/Reset inputs. Its Auto and Enable inputs initially share a true constant; Reset is false and manual duty is zero. Rewire these ports to appropriate signals for a live mode control. Changing a constant in a newly activated revision creates fresh controller state; it is not a bumpless mode change. Live numeric physical drivers and equipment faceplates remain pending.

## Graph contract

| Block | Input ports | Output | Parameters |
| --- | --- | --- | --- |
| `pid` | Numeric `pv`, `setpoint`, `manual`; boolean `auto`, `enable`, `reset` | Number from 0 through 1 | Required `pid` object described below |
| `pwm` | Numeric `in`, constrained to 0 through 1 | Boolean | Integer `windowMs`, 1000–60000 |

All ports must be connected before preparation. There are no implicit numeric/boolean conversions. A PID cannot directly command a boolean output; use time proportioning or an explicit comparison. Wrong types, missing fields, unknown nested settings and invalid ranges are rejected. Manual duty must be finite and in range even while Auto is selected. Invalid input cannot be bypassed by Disable or Reset.

PID settings contain exactly `kp`, `ki`, `kd`, `derivativeMs` and `maxIntervalMs`. Gains are finite, nonnegative numbers. The derivative filter is an integer from 1 to 60000 ms; the maximum interval is an integer from 100 to 60000 ms. Kp scales the input error to normalized output; Ki is per second and Kd uses seconds. Process value and setpoint must use matching engineering units. The initial direction is heating/reverse acting: positive setpoint-minus-measurement error increases demand. A separate cooling/action selector is not implemented.

## Calculation semantics

Time is monotonic and nonnegative. Each valid update computes `error = setpoint - pv` and `P = Kp * error`. Integral increments use the current sampled error and actual elapsed seconds. No unobserved intermediate samples or catch-up ticks are invented. All intermediate arithmetic must remain finite; overflow is a fault, not saturation of Infinity.

The derivative uses measurement changes, not setpoint changes. For positive elapsed time, it computes the measured rate and exponentially smooths it with `alpha = 1 - exp(-elapsedMs / derivativeMs)`. The D contribution is the negative filtered rate times Kd. Equal timestamps hold the derivative and do not integrate. The first automatic sample has zero integral/derivative and produces the clamped proportional output; cold startup is not guaranteed to be bumpless.

Output is constrained to [0, 1]. Conditional integration prevents changes deeper into saturation. For a positive integral increment, the accepted increment is limited to the positive remaining headroom above the current unsaturated P+I+D. For a negative increment, it is limited to the negative headroom toward zero. An increment crossing a boundary reaches that boundary rather than being discarded entirely. Error reversal can unwind the integral immediately. This is the project's specified discrete rule, not an assertion that its implementation is identical to another vendor's PID block.

In Manual, output equals the requested manual duty and integral state tracks `manual - P - D`. On Manual→Auto, the previous manual output is preserved for that calculation and integral state is adjusted to current P and D; integration resumes on the following calculation. Auto→Manual immediately applies the explicit manual duty, so a deliberately different manual request can cause a step. Disable or Reset returns zero and discards state. The next enabled automatic calculation starts fresh.

An interval beyond `maxIntervalMs`, nonfinite calculation or invalid input produces Bad in the graph, clears controller state and inhibits downstream output. The graph task's existing preflight revokes output authority before issuing new commands from an invalid output set. A subsequent activation creates new state. There is no retentive integral, automatic tuning, gain scheduling, feedforward or external actuator tracking in this profile. Anti-windup uses the requested normalized output bounds, not measured physical actuator achievement.

The design uses the established concepts of conditional integration and manual tracking documented in [MathWorks anti-windup guidance](https://www.mathworks.com/help/simulink/slref/anti-windup-control-using-a-pid-controller.html) and [manual-to-auto transfer guidance](https://www.mathworks.com/help/simulink/slref/bumpless-control-transfer-between-manual-and-pid-control.html). The formulas and limits above define Open APCS behavior independently.

## Time proportioning

The first valid sample establishes the window origin and duty. Positive duty updates are held until a new window; the output is ON while elapsed position within that window is below its sampled duty times window length. A zero request immediately cancels remaining ON time and holds OFF until the next window. Whole elapsed windows are skipped, with no replayed pulse train. Invalid input and new graph activation discard the window state.

This is server-side sampled time proportioning, not hardware PWM. The standard graph task runs no faster than 100 ms, and actual command timing also depends on transport and acknowledgement. Small pulses may be missed or quantized; relay minimum on/off times are not enforced. The initial preset is intended for the virtual heater and LED engineering bench. Independent hardware protections remain necessary for real processes.

The virtual plant now observes heater state approximately every 50 ms while publishing numeric telemetry about once per second. Each model update integrates the preceding observed heater state over actual elapsed time. This allows short pulses between telemetry publications to affect the model. It is still a sampled approximation, not real-time actuator simulation or firmware emulation.

## Verification and limits

Pure Docker tests cover proportional/integral/derivative behavior, output bounds, anti-windup, changed-setpoint Manual→Auto transfer, disable/reset, monotonic time, excessive gaps, overflow, strict settings and duty windows. A five-minute virtual-time test drives the existing thermal model with binary duty output; its final-minute mean is within 0.6 C of 24 C and samples stay within 22.5–25.5 C. That test uses 100 ms model/controller steps and is not a five-minute wall-clock or hardware endurance test.

Graph/API tests cover mixed port types, invalid-result propagation, revision persistence, pure simulation without command records, actual MQTT command verification, numeric telemetry and faulting after device stop. A broker integration test verifies a 300 ms heater pulse occurring between one-second telemetry publications. Chromium covers device selection, template properties, simulation, preparation and live virtual activation. Physical process tuning, hardware timing, load profiles and complete M2 acceptance remain pending.
