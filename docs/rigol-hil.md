# Rigol DS1054Z USB hardware fixture

## Scope

This opt-in fixture commands one explicitly reviewed external GPIO18 LED through the authenticated HTTPS API and measures its electrical waveform independently with a Rigol DS1054Z. It does not require a human to watch each pulse. It does not establish optical LED operation, continuous recording without gaps, calibrated metrology, command-to-edge latency, watchdog timing or full M1 acceptance.

The initial physical run on 2026-10-13 used DS1054Z firmware `00.04.04.SP3`, the existing GOOUUU ESP32 firmware and the existing local TLS broker. All three commands (initial OFF, ON, final OFF) reached `Verified`. A fresh triggered capture measured a 1.25 s pulse, mean high 3.271 V, mean low -0.010 V, and 1200 points spaced 5 ms apart. The worker and its independent supervisor both confirmed the runtime stopped afterward. The physical run used the same Docker image as application development; no image rebuild or new dependency was required.

## Wiring and prerequisites

- A passive probe physically set to 10x, CH1 tip on labelled G18 before the LED resistor, ground clip on ESP32 GND.
- The external LED remains connected through its series resistor to GND. This profile is only for the reviewed low-voltage LED bench.
- Rigol's rear USB Device port connects to the Linux server. The kernel exposes `/dev/usbtmcN`; select the current path explicitly, because its number can change.
- The configured ESP32 must already be provisioned for GPIO18 and included in the server's private GPIO18 allowlist. Its runtime must be stopped before testing. No other operator, graph or program may control this dedicated fixture during a run.
- Local HTTPS and its trusted certificate, valid owner credentials and an exact instrument serial number are required. Neither TLS verification nor the application command journal is bypassed.

## Private configuration

Prepare an owner-controlled directory outside Git with `config.json`, `access.txt` and `server-ca.crt`. Example `config.json`:

```json
{
  "origin": "https://server.example:8443",
  "deviceId": "00000000-0000-0000-0000-000000000000",
  "scopeSerial": "DS1ZA000000000",
  "gpio": 18,
  "credentialsFile": "/run/bench/access.txt"
}
```

`access.txt` contains `Username: ...` and `Password: ...` on separate lines. Use the actual device catalog UUID and scope serial. `server-ca.crt` is the trusted LAN server certificate/CA, not a private key. The script currently searches only the first 100 devices/signals and requires exactly one boolean output for the selected device; it fails rather than guessing a missing target.

For the supplied Linux development profile, the private directory belongs to UID/GID 1000, mode 0750, with files mode 0640; the artifact directory belongs to the same user/group, mode 0770. The container runs as root only to open the root-owned USBTMC device, drops every capability, and uses supplementary GID 1000 to read the private files and write artifacts. It has a read-only filesystem and source mount, no Docker socket, and receives exactly one USB device. Measurement files may be owned by root; credentials are not written into them.

```sh
APCS_SCOPE_DEVICE=/dev/usbtmc1 \
APCS_BENCH_PRIVATE=/absolute/path/to/private-rigol-config \
APCS_BENCH_ARTIFACTS=/absolute/path/to/measurement-artifacts \
make hil-rigol
```

The external `open-apcs-test_node_modules` volume must already contain the workspace dependencies. The fixture uses mounted TypeScript directly. Ordinary `make test`, development watch and CI never arm this hardware. The fixture uses the local HTTPS endpoint and requires no internet service.

## Acquisition and evidence

The worker verifies the model and serial, reads previous basic settings into an artifact, and configures CH1 for 10x/DC/non-inverted acquisition, 1 V/div, -1.6 V offset, and a 500 ms/div main timebase. CH2–CH4 are disabled. A rising-edge single trigger on CH1 at 1.65 V and an observed WAIT state establish a fresh capture; a low pretrigger interval is collected before sending ON. One second after the ON acknowledgement the worker sends OFF. The observed pulse includes application/network acknowledgement overhead, so its duration is not a pure scheduler measurement.

After acquisition stops, BYTE/NORMAL data and its preamble are read from the frozen capture. The decoder accounts for both vertical origin and reference. It rejects malformed/truncated/oversized blocks, mismatched point counts and clipped samples. The pulse check requires exactly one rise/fall, stable 2.8–3.6 V high and -0.3–0.4 V low plateaus, a 0.7–2.5 s pulse and at least 100 ms of low evidence on both sides. These are fixture acceptance bounds, not specifications for every ESP32 output. The 5 ms display sampling interval cannot rule out shorter glitches.

Each timestamped artifact directory contains previous scope settings, the waveform preamble, raw SCPI block, scaled CSV, and a JSON result with command IDs/timestamps and measurement statistics. A failed run exits nonzero and preserves available evidence. Only a successful process exit plus its result counts as a pass. The scope remains stopped on the captured trace for inspection; the configured channel/trigger settings are not restored automatically.

The connected firmware timed out on both `:SYST:ERR?` and the full `:SYSTem:ERRor:NEXT?` spelling, while identity and setting queries still worked. This fixture therefore verifies required settings by readback and checks the standard event status register for error bits. It does not assume the error queue is available and does not change the instrument firmware.

## Cleanup and limitations

The acquisition worker attempts to disarm in `finally`. A separate parent process stays responsive while the USB worker performs blocking reads, enforces a 90 s worker deadline, and independently requests disarming once arming may have begun. The artifact-directory lock remains held until supervisor cleanup completes, preventing overlapping runs that use that directory. All runs for a physical instrument must share that directory; this is not a global instrument lock against unrelated software.

Unit tests cover worker failure, deadline killing and cleanup failure propagation. These tests do not establish physical behavior after a complete container/server/power failure. If the parent is also killed or cannot reach the API, automatic cleanup is not guaranteed: stop the fixture through the application. The device watchdog only removes authority when gateway renewals cease. A stale lock after an unclean container exit must be investigated and removed only after confirming the runtime is stopped and no measurement process remains.

The fault scenarios below add bounded physical evidence. Wi-Fi interruption, full power loss, task-watchdog injection, replay under reconnect stress and L0 endurance remain separate acceptance work.

## References

Commands, BYTE scaling and acquisition modes follow the manufacturer's [DS1000Z programming guide](https://telonic.co.uk/jg/wp-content/uploads/2021/05/Rigol-DS1000Z-ProgrammingGuide.pdf). The dedicated fixture uses Linux USBTMC through Node's file APIs; it does not install proprietary Windows software or modify instrument firmware.

Repository validation for this increment: 558 unit/integration tests, six Chromium scenarios, 420 native C checks and ESP32 cross-compilation passed in Docker, including type checking, English validation, renderer recovery, offline dependency installation/build and database backup/restore. The physical result above is separate evidence from the opt-in fixture.

## Fault scenarios

The fixture also supports `lease-expiry`, `broker-loss` and `device-reset`. These scenarios issue initial OFF and then ON through the journal, wait 500 ms after Verified ON, and inject the selected fault without issuing OFF. The scope uses 1 s/div with 1200 BYTE/NORMAL samples, nominally 10 ms apart. A valid trace must contain one complete 0.1–5 s pulse, valid voltage plateaus and at least 500 ms of low evidence on each side.

- `lease-expiry` stops the commissioned runtime through the API. This removes gateway renewal; the device must independently expire its remaining lease.
- `broker-loss` pauses only the explicitly selected dedicated physical broker container. This interrupts delivery without immediately closing the TCP connection. The host restores the broker after the first capture, and also attempts restoration after failure/interruption. It does not stop the simulation broker or disable host networking.
- `device-reset` resets the reviewed USB ESP32 with DTR/RTS. A pinned ESP-IDF container is prepared before measurement and opens the serial port only at injection. ROM boot and application startup messages must confirm the reset. This is a reset test, not a power-cycle or brownout test.

After fault capture and broker restoration/reset completion, a separate AUTO acquisition runs for 14 s and freezes a fresh approximately 12 s window. Every sample must remain between -0.3 and 0.4 V for at least 10 s; runtime state must be stopped or faulted. This window has a gap from the triggered trace and does not prove continuous absence of short glitches. Expected historical fault messages are retained; final cleanup still requires a stopped runtime.

For lease expiry and broker loss, the fixture brackets ON request/Verified acknowledgement and fault request/completion with the worker's monotonic clock. The measured pulse width and sample uncertainty give a conservative interval for fault-to-LOW delay; its upper bound must not exceed 3.5 s. This is a bench acceptance tolerance around the 3 s device lease, not a changed protocol deadline. USB acquisition timestamps are never assumed to equal host timestamps. USB reset completion includes application startup, so reset-to-LOW latency is deliberately not inferred from that broad bracket.

Set the same three private fixture variables as above, then run:

```sh
APCS_HIL_MODE=lease-expiry make hil-rigol

APCS_BENCH_BROKER=open-apcs-bench-physical-mqtt-1 \
python3 scripts/hil-fault.py broker-loss

APCS_SERIAL_DEVICE=/dev/serial/by-id/your-reviewed-esp32 \
python3 scripts/hil-fault.py device-reset
```

The two external fault modes require the host orchestrator. It validates the broker's Compose project/service and initial running/unpaused state, pins the inspected container ID, and accepts only injection/restoration requests for the selected mode and unique run token. The measuring container receives no Docker socket. Python on the host only coordinates Docker; waveform checks, API operations and USB reset code run inside existing containers. The reset helper requires the already-installed pinned ESP-IDF image and Python serial module. `make hil-orchestrator-test`, also included in `make test`, tests cleanup with fake Docker and never touches hardware.

A failed Docker pause command still triggers an unpause attempt because its side effect may already have happened. SIGINT/SIGTERM and ordinary errors enter cleanup. Killing the host orchestrator with SIGKILL or losing the host can prevent broker restoration; inspect the selected broker and stopped runtime before another run. Neither this fixture nor Docker provides independent functional safety.

### Physical results, 2026-10-13

The same GPIO18 LED, DS1054Z, firmware and TLS bench profile were used for all runs. Raw blocks, preambles, CSV files and JSON results are retained under the ignored local `.cache/hil` directory.

| Scenario / artifact directory (UTC) | High mean | Pulse width | Fault-to-LOW interval | Subsequent LOW window | Runtime before cleanup |
| --- | --- | --- | --- | --- | --- |
| Lease expiry / `2026-10-13T12-35-51.347Z` | 3.268 V | 3.06 s | 2.340–2.570 s | 11.99 s | stopped |
| Broker pause/restore / `2026-10-13T12-37-43.217Z` | 3.268 V | 2.80 s | 1.706–2.310 s | 11.99 s | faulted |
| USB reset / `2026-10-13T12-41-04.907Z` | 3.270 V | 0.68 s | not claimed | 11.99 s | faulted |

All three runs passed; each subsequent LOW window measured -0.24 to 0.16 V at 10 ms display intervals. The worker and independent supervisor confirmed stopped runtime afterward. The broker was restored. No automatic ON or running state was observed in those windows.

The initial reset attempt, `2026-10-13T12-38-40.877Z`, failed waveform acceptance: starting the reset container after ON delayed injection beyond the captured window, leaving a rise without a captured fall. It is not counted as a passing run. Prestarting the helper corrected this acquisition problem; the voltage and pulse acceptance bounds were not relaxed.

These are single-run engineering observations, not calibrated worst-case guarantees. The simulated fast-reboot regression separately proves that a changed boot cannot receive a replacement lease without an explicit gateway restart, and that a previously accepted command is cancelled. The slower physical reboot usually faults through a handshake timeout; it does not independently exercise the fast-reboot branch.
