# Virtual thermal process

The `virtual-thermal` device profile supplies a boolean heater output and a float64 temperature input. It runs in the private runtime worker and uses real MQTT for both the existing acknowledged heater protocol and numeric sensor telemetry. This is a fixed engineering model for testing a closed loop without a board. It does not execute ESP32 firmware or represent validated physical equipment.

## Operator workflow

In Devices, register a Virtual thermal process and start its simulator. In Logic, create a graph and choose Thermostat template. Select Template device when the project has several thermal devices. The template binds that device: temperature → hysteresis (low 23, high 24) → NOT → heater. Review the generated bindings before activation. Save, prepare, give an activation reason and activate. Initial temperature is 20 C, so the heater turns ON. At the high threshold it turns OFF; cooling to the low threshold turns it back ON. The intermediate NOT is necessary because the hysteresis block represents the warm condition.

Signals displays temperature to two decimal places, its type and quality. Display rounding does not change control inputs or archived values. Input signals have no manual control; the command API also rejects attempts to command them before writing a journal entry. Screens supports a read-only Value item bound to a float64 signal; indicator lamps and buttons keep boolean bindings. Add units to the item label. A prepared screen shows the number and quality on the scene and in a readable responsive Readings panel, preserving the last number with Disconnected/Stale quality rather than showing a fabricated zero.

Stopping the device disconnects both signals. Dependent graph tasks fault and revoke their output authority. Restarting a simulator starts a new boot and fresh model; it does not automatically reactivate graphs. The existing explicit Unknown reconciliation workflow also supports this virtual heater: it requires a new boot, Good observed OFF state, output ownership, operator acknowledgement and audit. The old outcome remains Unknown and is never replayed.

## Model and scheduling

The fixed model starts at ambient 20 C. Its heated equilibrium is 40 C and its time constant is 20 seconds. Each sample applies the preceding sampled boolean heater state over the elapsed monotonic interval:

`temperature = equilibrium + (previousTemperature - equilibrium) * exp(-elapsedMs / 20000)`

This is a sampled approximation with up to one sample of heater observation delay, not a continuous model of actuator timing. Heater observation/model updates are scheduled approximately every 50 ms; numeric telemetry is published one second after the preceding publication completes. Neither loop overlaps itself or catches up. Short heater pulses between publications can therefore affect the temperature. An elapsed interval exceeding 2500 ms faults the process. Temperature stays within 20–40 C. Five kernel cases exercise heating, cooling, equilibrium, invalid/late time and a repeatable 120-second virtual-time closed loop. They are not a 120-second wall-clock load or HIL test.

A separate PID thermostat template supports normalized regulation and time proportioning; see [PID contracts](pid-control.md). Both templates use the explicit Template device selector.

## Transport and failure behavior

Every simulator start allocates the same random private MQTT namespace as its heater session. The sensor topic appends `/temperature` to that session's LED output topic. Payload is `{v:1, bootId, sequence, value}` with exactly four fields, a pinned boot, nonnegative safe-integer sequence and finite temperature within the model range. Values are ingested only into the configured sensor binding and the already-established device boot session. The receiver rejects retained packets, non-QoS-1 delivery, oversized/malformed data, unknown fields, foreign boots and invalid values. SignalStore rejects duplicate/out-of-order samples. MQTT uses clean sessions, no automatic reconnect, non-retained QoS 1 and one-second expiry. Source time is absent; history records server observation time.

Publication is bounded to one second. Connection loss or overdue sampling disconnects sensor quality, stops the device runtime and records a process fault. Stopping the runtime revokes the heater lease; no immediate physical OFF verification is claimed. In this profile the heater is entirely virtual. Numeric sample validation is not authentication: the private broker/network and unguessable per-run namespace isolate simulation, but this adapter is not offered for physical or third-party sensors. No physical pins or private physical broker configuration are used.

The existing limit of 16 active devices remains. Process tuning, arbitrary models, numeric actuators, real numeric sensor drivers, dedicated fault-injection controls, firmware emulation and scale acceptance remain pending. Quality and high/low threshold alarms can monitor the numeric input; see [alarm semantics](alarms.md). Raw history and analog aggregation use the existing common pipeline.

## Acceptance evidence

Docker integration tests use an actual MQTT broker, including interrupted TCP transport, retained/foreign/invalid frames, stop and late sampling. The application test activates a numeric graph, observes both verified ON and OFF heater commands, checks numeric history and faults the graph when its device stops. API tests enforce read-only input and numeric HMI binding rules and preserve Unknown outcomes during virtual-heater reconciliation. Chromium covers registration, template activation, live numeric monitoring, numeric HMI and device-stop propagation. These results are simulator verification only.
