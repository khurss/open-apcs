# Private device runtime

The current working path is web UI → authenticated API → durable PostgreSQL command journal → separate runtime process → MQTT → virtual LED acknowledgement. Virtual profiles remain isolated by default. An explicitly configured ESP32 LED bench can now use a TLS broker; see [physical commissioning](physical-commissioning.md). Firmware is cross-compiled; physical GPIO tests remain pending.

## Operator workflow

Run `make dev`, sign in, register a project and a **Virtual LED** device, and choose **Start simulator** on its device card. The API starts the device in its private worker process. In **Signals**, wait for Good quality, open **Control**, enter a command reason, and send ON/OFF. The command panel follows the journal state until a terminal result. `Verified` means the protocol peer reported applying that command; signal telemetry alone does not acknowledge a command.

The worker dispatches and renews sessions while the browser is closed. **Stop simulator** revokes the session and disconnects signal quality. Restarting a simulator creates a new boot/session and initializes its LED to OFF. A worker/API restart does not restore control authority: simulators must be started explicitly again. API source hot reload also restarts the worker and therefore requires rearming virtual devices.

The initial profile permits 16 simultaneously running devices. This is a bounded engineering profile, not the 10,000-device target. There is no persistent deployment manifest or autonomous remote gateway in this increment. Prepared graphs can now execute in the private worker against explicitly started virtual devices. ESP32 bench commissioning requires a private allowlist and explicit operator review.

## Process and ownership boundaries

`RuntimeProcess` starts a fixed TypeScript worker with a private Node IPC channel. The browser cannot choose executable paths, broker addresses, service actors, or process configuration. IPC has a maximum of 256 outstanding requests and a five-second operation deadline. Timeout terminates the worker and rejects outstanding requests; it does not replay commands. The API owns worker lifecycle and closes it on shutdown. The worker also stops on IPC disconnection.

Before enabling devices, `SimulationRuntime` holds a PostgreSQL session advisory lock scoped to the application schema. Another executor for that workspace cannot take ownership until the lock is released. Each dispatch/session renewal refreshes project policy through that owning connection. Loss of the ownership connection stops its device runtimes, marks quality Disconnected, and exposes a fault. Restart the API service before explicitly rearming after this fault. This is a single-host ownership guard, not the future HA/fencing implementation; network-partition and split-brain certification are not claimed.

Only the authenticated project owner can start its virtual device. The gateway supplies dispatch-time ownership, project revision, boot session, freshness, interlock, and TTL policy to the existing journal. Catalog renames/revision changes are re-read before dispatch; stale browser commands are rejected. Operator-supplied actor IDs remain forbidden.

A start request is audited before enabling its runtime, followed by a completion record. Failure to record completion stops the newly enabled runtime. Stop still attempts to revoke control if its audit request fails. Failed requests return an error instead of a success claim. Worker crashes can leave a requested audit event without completion; command outcomes remain independently represented in the durable journal.

## Simulation transport isolation

`compose.yml` includes `simulation-mqtt` on the internal development network, with no host port publication. Anonymous access belongs only to this isolated virtual-device broker. Each virtual startup uses a random simulation site namespace, so it does not address the physical site/device topic stored in the catalog. The simulator and gateway use the same bounded LED protocol as the tested device contract, with retained-message rejection and boot/session validation.

Transport configuration distinguishes the stable catalog `deviceId` from `protocolDeviceId`, its MQTT address. Signal sessions/disconnection use the catalog identity; MQTT topics use the address. A real transport test verifies the distinction.

The simulation setup does not enable physical transport. The separate bench configuration requires TLS, broker credentials and an address allowlist; the administrator provisions the production CA and per-device broker ACLs. The virtual peer does not execute an ESP32 binary. Its timing and safe-state limitations remain documented in [the LED contract](led-network.md).

## API additions

| Route under `/api/v1` | Behavior |
|---|---|
| `GET /devices/:id/runtime` | Device runtime state, transport profile and diagnostics |
| `POST /devices/:id/runtime` | Audited `start`/`stop` with a nonempty reason |
| `GET /signals/:id/value` | Private-worker snapshot for running devices |
| `POST /commands` | Existing journal route, using trusted worker context |

Physical profiles return 422 from the runtime mutation route. An unconfigured runtime returns 503. No request automatically starts an uncommissioned output. HTTP acceptance is distinct from application/verification; unknown or unavailable results must be inspected before issuing another command. Unresolved journal `Unknown` outcomes block the output. Explicit virtual LED reconciliation is now available after a new boot/session and a Good OFF observation; see [the recovery contract](command-journal.md#explicit-virtual-led-reconciliation).

The main API creates the worker only when `APCS_MQTT_URL` is configured. API tests can inject another trusted context/reader, while browser fixtures use the actual private process and real PostgreSQL/MQTT containers. The worker receives database configuration through its process environment, not command-line arguments or logs. Production secret provisioning remains part of the later deployment profile.

## Verification

Docker tests cover demand-only startup, physical-profile rejection, actor ownership, two competing executors, current project revisions, stop/cancellation, a changed boot after restart, real IPC, forced process termination, and terminated PostgreSQL ownership sessions. The API suite verifies the durable command path and revokes newly enabled control when completion audit insertion fails. Chromium creates a device, starts its simulator, issues a reasoned command, observes Verified/ON, and stops the simulator.

No physical hardware state, electrical interlock, independent safety function, or final scale profile is inferred from these tests.

## Prepared graph execution

In Logic, save and prepare a revision, enter an activation reason, and choose **Activate revision N**. The graph keeps executing after page navigation, logout, or closing the browser. The runtime panel distinguishes the running revision from the editable draft. Unsaved changes never change the active graph. **Stop graph** stops the graph and revokes its output devices' sessions; restart those simulators explicitly before another activation.

Activation validates the immutable revision checksum, complete graph, project owner, signal bindings, Good quality, and running devices. Each activation receives a unique private service principal. Output ownership excludes manual commands and other graphs. Activation of a nonexistent or corrupted revision leaves the current graph unchanged. The API audits the authenticated operator, reason, revision, and activation ID. Completion audit failure revokes only that generation, so delayed compensation cannot stop a newer activation.

The scheduler defaults to a 100 ms delay after each completed cycle, without overlapping cycles or catch-up bursts. It is not a hard-real-time scheduler. A cycle has a 2,000 ms asynchronous budget. It requires Good boolean snapshots and stable device boot identities, emits changed targets through the durable command journal, and waits for each output's previous command to be Verified before issuing its next target. Rejected, expired, unknown, or failed commands fault the graph and revoke its output sessions. Current telemetry is not a substitute for command acknowledgement. Unexpected feedback drift after a Verified result does not yet have a dedicated divergence alarm or automatic resend.

A revision switch validates the replacement before pausing the previous graph. It drains pending commands for up to 2,500 ms, transfers shared output ownership, revokes removed outputs, and starts the new graph with fresh volatile timer/latch state. Shared devices retain their boot/session. If pending outcomes cannot be verified, the previous generation is stopped rather than replayed. The IPC deadline still bounds the whole operation; timeout kills the worker and leaves control unarmed. Stop/restart, bad quality, and worker failures require explicit operator rearming.

| Route under `/api/v1` | Behavior |
|---|---|
| `GET /graphs/:id/runtime` | Active revision, activation ID, state, cycle count, and fault |
| `POST /graphs/:id/runtime` | Audited `activate` with a prepared revision and reason, or `stop` with a reason |

Prepared revisions and audit history are durable. Active ownership and timer state are deliberately volatile and are not restored after worker/API restart. There is no durable deployment manifest or automatic resume in this profile. The scheduler and revision-switch tests use virtual LEDs only; physical timing, independent safety functions, and full load profiles remain unverified.
