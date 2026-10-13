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

Network interruption, independent lease/watchdog timing, reboot/no-replay acceptance and L0 endurance still require separate physical scenarios. This fixture establishes automated electrical ON/OFF evidence only.

## References

Commands, BYTE scaling and acquisition modes follow the manufacturer's [DS1000Z programming guide](https://telonic.co.uk/jg/wp-content/uploads/2021/05/Rigol-DS1000Z-ProgrammingGuide.pdf). The dedicated fixture uses Linux USBTMC through Node's file APIs; it does not install proprietary Windows software or modify instrument firmware.

Repository validation for this increment: 558 unit/integration tests, six Chromium scenarios, 420 native C checks and ESP32 cross-compilation passed in Docker, including type checking, English validation, renderer recovery, offline dependency installation/build and database backup/restore. The physical result above is separate evidence from the opt-in fixture.
