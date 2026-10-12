# Private virtual-device runtime

The current working path is web UI → authenticated API → durable PostgreSQL command journal → separate runtime process → MQTT → virtual LED acknowledgement. It is a simulation profile and cannot commission `esp32-led` or other physical devices. Compiled firmware and physical GPIO tests are still pending.

## Operator workflow

Run `make dev`, sign in, register a project and a **Virtual LED** device, and choose **Start simulator** on its device card. The API starts the device in its private worker process. In **Signals**, wait for Good quality, open **Control**, enter a command reason, and send ON/OFF. The command panel follows the journal state until a terminal result. `Verified` means the protocol peer reported applying that command; signal telemetry alone does not acknowledge a command.

The worker dispatches and renews sessions while the browser is closed. **Stop simulator** revokes the session and disconnects signal quality. Restarting a simulator creates a new boot/session and initializes its LED to OFF. A worker/API restart does not restore control authority: simulators must be started explicitly again. API source hot reload also restarts the worker and therefore requires rearming virtual devices.

The initial profile permits 16 simultaneously running virtual devices. This is a bounded engineering profile, not the 10,000-device target. There is no persistent deployment manifest or autonomous remote gateway in this increment. Graphs can still be simulated and prepared, but live graph activation is the next step.

## Process and ownership boundaries

`RuntimeProcess` starts a fixed TypeScript worker with a private Node IPC channel. The browser cannot choose executable paths, broker addresses, service actors, or process configuration. IPC has a maximum of 256 outstanding requests and a five-second operation deadline. Timeout terminates the worker and rejects outstanding requests; it does not replay commands. The API owns worker lifecycle and closes it on shutdown. The worker also stops on IPC disconnection.

Before enabling devices, `SimulationRuntime` holds a PostgreSQL session advisory lock scoped to the application schema. Another executor for that workspace cannot take ownership until the lock is released. Each dispatch/session renewal refreshes project policy through that owning connection. Loss of the ownership connection stops its device runtimes, marks quality Disconnected, and exposes a fault. Restart the API service before explicitly rearming after this fault. This is a single-host ownership guard, not the future HA/fencing implementation; network-partition and split-brain certification are not claimed.

Only the authenticated project owner can start its virtual device. The gateway supplies dispatch-time ownership, project revision, boot session, freshness, interlock, and TTL policy to the existing journal. Catalog renames/revision changes are re-read before dispatch; stale browser commands are rejected. Operator-supplied actor IDs remain forbidden.

A start request is audited before enabling its runtime, followed by a completion record. Failure to record completion stops the newly enabled runtime. Stop still attempts to revoke control if its audit request fails. Failed requests return an error instead of a success claim. Worker crashes can leave a requested audit event without completion; command outcomes remain independently represented in the durable journal.

## Simulation transport isolation

`compose.yml` includes `simulation-mqtt` on the internal development network, with no host port publication. Anonymous access belongs only to this isolated virtual-device broker. Each virtual startup uses a random simulation site namespace, so it does not address the physical site/device topic stored in the catalog. The simulator and gateway use the same bounded LED protocol as the tested device contract, with retained-message rejection and boot/session validation.

Transport configuration distinguishes the stable catalog `deviceId` from `protocolDeviceId`, its MQTT address. Signal sessions/disconnection use the catalog identity; MQTT topics use the address. A real transport test verifies the distinction.

Production broker authentication, per-device ACLs, TLS/certificate provisioning, and physical profiles are not enabled by this simulation setup. The virtual peer does not execute an ESP32 binary. Its timing and safe-state limitations remain documented in [the LED contract](led-network.md).

## API additions

| Route under `/api/v1` | Behavior |
|---|---|
| `GET /devices/:id/runtime` | Simulation runtime state and diagnostics |
| `POST /devices/:id/runtime` | Audited `start`/`stop` with a nonempty reason |
| `GET /signals/:id/value` | Private-worker snapshot for running virtual devices |
| `POST /commands` | Existing journal route, using trusted worker context |

Physical profiles return 422 from the runtime mutation route. An unconfigured runtime returns 503. No request automatically starts an uncommissioned output. HTTP acceptance is distinct from application/verification; unknown or unavailable results must be inspected before issuing another command. Explicit reconciliation of journal `Unknown` outcomes remains pending, and such outcomes continue to block that output.

The main API creates the worker only when `APCS_MQTT_URL` is configured. API tests can inject another trusted context/reader, while browser fixtures use the actual private process and real PostgreSQL/MQTT containers. The worker receives database configuration through its process environment, not command-line arguments or logs. Production secret provisioning remains part of the later deployment profile.

## Verification

Docker tests cover demand-only startup, physical-profile rejection, actor ownership, two competing executors, current project revisions, stop/cancellation, a changed boot after restart, real IPC, forced process termination, and terminated PostgreSQL ownership sessions. The API suite verifies the durable command path and revokes newly enabled control when completion audit insertion fails. Chromium creates a device, starts its simulator, issues a reasoned command, observes Verified/ON, and stops the simulator.

No physical hardware state, electrical interlock, independent safety function, or final scale profile is inferred from these tests.
