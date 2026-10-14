# Explicit recovery of an Unknown LED command

Status: recovery delivery verified in Docker and on the GPIO18 bench. Extended endurance acceptance remains a separate gate. This increment applies only to the existing isolated ESP32 LED bench. It does not define a recovery policy for pumps, heaters, machinery or safety systems.

## Contract

An unresolved Unknown command continues to block its output. Recovery never changes that command to Verified, deletes its history, retries its consumed intent, restarts a graph or sends an output command. It adds a separate, auditable reconciliation receipt permitting a later, explicitly requested command.

The owner must disarm the bench, restart the physical controller, and explicitly commission the reviewed GPIO with only an isolated LED connected. A server or browser restart is not a new device boot. The existing commissioning path checks the private address/pin allowlist and a Good OFF output. Recovery additionally requires:

- An authenticated project owner, CSRF protection and a nonempty explanation.
- Explicit acceptance that the old outcome remains unknown and renewed acknowledgement of the isolated LED profile.
- A reviewed GPIO matching the current active physical commissioning session.
- A Good current output sample, matching live control-session boot, a different boot from the unknown command, OFF value, current ownership and no interlock.
- An atomic reconciliation receipt and audit commit; an audit failure preserves the output block.

`GET /signals/:id/commands` reports the catalog profile so the control panel displays the appropriate recovery instructions. `POST /commands/:id/reconcile` retains the virtual request body `{reason, acceptUnknownOutcome: true}`. Physical LED requests additionally require `{gpio, acknowledgeLedOnly: true}`. Caller-supplied observed values, boot IDs and actors are rejected. Runtime status exposes only the reviewed commissioned GPIO, never connection credentials.

The observed OFF value is firmware feedback; it is not independently measured electrical state or proof of the historical outcome. The bench acceptance separately uses the existing Rigol fixture for electrical observation. Other hardware profiles remain unsupported. Physical recovery does not bypass existing expiry, lease, replay or ownership checks.

## Delivery plan

1. RED/GREEN API and real TLS simulator regressions for owner/CSRF, explicit acknowledgement, active matching GPIO, new boot, no replay, original history, idempotency and audit rollback. Existing journal tests retain stale/high/foreign/interlocked-state rejection coverage.
2. Browser recovery on the isolated TLS fixture through the private runtime worker, with explicit profile-specific instructions and disabled incomplete actions.
3. Full Docker regression with existing images and mounted source; update documentation.
4. Recover the already-authorized GPIO18 physical LED through the public audited API, using its new firmware boot and Good OFF feedback. Preserve the old Unknown outcome.
5. Repeat physical acceptance and the extended L0 endurance profile. Record passes, failures, cleanup and limitations without substituting the shorter OFF renewal diagnostic.

## Acceptance evidence

The focused Docker TLS/API and journal suites passed 23 cases. Chromium recovery passed for both virtual and physical profiles through the private runtime worker. The physical browser fixture is a TLS protocol simulator, not an electrical measurement. An intermediate browser failure identified a missing explicit accessible name on the GPIO selector; the corrected scenario passed.

At 2026-10-14 10:09:31 UTC the public API reconciled the previously preserved physical endurance command against a different controller boot and Good OFF GPIO18 feedback. Its original Unknown state, transition history and missing historical outcome were preserved; a separate receipt and GPIO/LED review audit were committed. No output command was issued during recovery, and the runtime was explicitly stopped afterward. Local evidence: `physical-recovery-2026-10-14.json` under ignored bench artifacts.

A subsequent commanded pulse and all four existing Rigol fault scenarios passed; see [the electrical evidence](rigol-hil.md#physical-recovery-regression-2026-10-14). The extended-hour gate remains open until the subsequent physical workload completes. See [M1 reliability](m1-reliability.md), [TDD log](tdd-log.md), and [extended L0 workload](load-l0.md).

Final `make test` exited 0: 615 unit/integration tests in 74 files, all 14 Chromium scenarios, 448 native firmware checks, nine orchestration checks, ESP32 cross-build, renderer recovery, TypeScript/English validation, offline build and backup/restore. Existing images and source mounts were used.
