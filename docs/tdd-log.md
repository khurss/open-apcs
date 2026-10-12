# TDD log

## 2026-10-12: Start of M0

Prepared AT-02 contracts and tests for missing data, monotonic freshness, duplicate/reordered samples, boot sessions, type validation, exact int64/uint64, and snapshot isolation from internal state. The property-based scenario uses fixed seed 42.

Added infrastructure smoke tests for PostgreSQL transaction rollback and MQTT request/application ACK. These exercise the test environment, not a production driver.

| Check | Observed result |
|---|---|
| `docker compose -f compose.yml config --quiet` | Configuration syntax passed |
| `docker compose -f compose.test.yml config --quiet` | Configuration syntax passed |
| `sh -n scripts/install-deps.sh` | Shell syntax passed |
| `docker compose -f compose.test.yml run --rm --no-deps unit` | Exit 1: Docker socket permission denied; tests did not start |
| RED | Not reached: the test runner did not start |
| GREEN | Not reached; behavior implementation had not begun |

These syntax checks validated configuration; they were not application tests executed outside Docker. `SignalStore` remained an explicit stub rather than claiming TDD without a RED run.

## 2026-10-12: Access restored; first completed cycles

Built the Node 24.20.0 / pnpm 10.18.3 image, installed dependencies in Docker, and generated `pnpm-lock.yaml`. A repeated frozen installation passed without changing the lockfile. The initial access problem was resolved and is not counted as RED.

| Cycle | RED in Docker | GREEN in Docker |
|---|---|---|
| Signals | 18 tests failed with `Not implemented` | 18 passed after implementation |
| Validation and disconnect | Watch: 12 failed / 28 passed | Watch: 40 passed |
| Commands | 26 failed / 40 passed against the `CommandBook` stub | Full suite: 68 passed, including 2 infrastructure tests; typecheck passed |
| Virtual LED | 14 failed / 66 passed against the model stub | Full suite: 82 passed; typecheck passed |
| Signal and session configuration | Watch: 4 failed / 40 passed | Full suite: 86 passed; typecheck passed |

Command coverage includes interlock/owner/revision/boot checks before dispatch, idempotency and payload conflicts, monotonic deadlines, duplicate-dispatch prevention, application ACK, result evidence, lost ACK → `Unknown`, disconnect, and isolated snapshots/history. An initial missing-module import failure was replaced with a stub and a real run of 26 failing tests before implementation.

Virtual LED tests cover OFF at startup and lease expiration, deduplication, delayed commands, ownership changes, reboot, and invalid deadlines/values. Controlled clocks avoid real three-second waits.

Suite total: **44 signal + 26 command + 14 virtual LED + 2 infrastructure = 86 tests**. Every application check, including TypeScript, ran in Docker. PostgreSQL and Mosquitto were real isolated containers. Watch containers picked up source/test changes without rebuilding or restarting. After pinning digests, tooling was rebuilt from cache; ordinary TypeScript edits did not trigger image builds.

This verifies the implemented libraries, not completion of all AT-02/03/04/16, M0, or M1. At this point there was no API, web UI, real driver/firmware, durable command journal, or offline distribution. The GitHub Actions workflow existed but had not run remotely.

## 2026-10-12: PostgreSQL command journal and outbox

Added `@open-apcs/storage` with a migration and `PgCommandJournal`. State transitions reuse `CommandBook.restore`, avoiding an independent command state machine in persistence. Commands, new events, and outbox entries commit atomically; intents return only after a successful COMMIT. Each output allows one unfinished command; Unknown requires future explicit reconciliation.

| Check | Observed result |
|---|---|
| Initial RED | Full Docker suite: 17 failed / 86 passed. Three new domain restoration tests and 14 journal tests failed against stubs |
| First GREEN | TypeScript passed; 103 tests passed |
| Stalled resolver | Docker integration: 1 failed / 21 passed; test and cleanup timed out, demonstrating a held transaction |
| Bounded resolver | After timeout/AbortSignal implementation: full suite 109 passed; typecheck passed |
| Additional transaction/time boundaries | Verified no intent on COMMIT failure and expiration while awaiting context |
| Final `make test` | **111 passed**, 5 files; TypeScript passed; exit 0 |
| `make install` | Frozen lockfile, exit 0; new workspace package installed in Docker |
| SQL watch | Changing migration mtime triggered `RERUN packages/storage/migrations/001-command-journal.sql`, followed by 24 passing integration tests |

Total: **44 signal + 29 command + 14 virtual LED + 22 journal + 2 infrastructure = 111 tests**. Tests use real PostgreSQL and separate schemas. They cover concurrent deduplication/claiming, a new connection Pool, outbox/ACK audit rollback, a deferred trigger failing at COMMIT, migrations/checksums, deadlines, connection loss, Unknown, and late ACK. After COMMIT failure, the entry remained pending and available for another validation attempt; no intent was returned on error.

A worker failure after claim was modeled by omitting delivery and creating another repository instance. Actual power loss/process termination and disk durability were not tested. Database time between transactions has the limitations described in the [journal contract](command-journal.md). The PostgreSQL fixture remains temporary; production storage, backup/restore, periodic dispatcher/recovery, MQTT, and API are not connected yet.

No images were rebuilt during this increment. Container watchers detect TypeScript and SQL changes; `make watch-integration` was added. The full offline bundle, web UI, and remaining phases are still on the roadmap.

## 2026-10-12: English repository and publication preparation

Translated the README and all 11 documentation files into English before the first commit. Preserved requirement IDs, source links, acceptance criteria, and the distinction between implemented behavior and planned phases. Added contributor instructions requiring Docker TDD, hot reload, English content, and a commit/push after each completed phase.

Added `check:language` before typecheck/tests in the full Docker command. It first failed against untranslated documentation, then passed after translation: 42 text files, no Cyrillic. This is a repository-content guard, not an application behavior change or a restriction on Unicode user data.

`make test` passed with **111 tests across 5 files**, TypeScript, and the language guard; exit 0. Both Compose configurations validated. A static comparison against the pre-translation documents found no removed requirement IDs or source links; local Markdown file links resolved in the original workspace. No images were rebuilt. This publication preparation does not complete M0.

## 2026-10-12: Clean-runner dependency permissions

The first GitHub Actions run failed during dependency installation. A separate clean checkout owned by UID 1001, with empty dependency volumes and the existing UID 1000 tooling image, reproduced `EACCES` while creating `packages/storage/node_modules` (installer exit 243). This exposed a permission assumption hidden by the original developer workspace.

The workflow now gives UID 1000 ownership of its checkout before container operations and restores the runner's ownership in an always-run step before checkout cleanup. Application installation and tests remain non-root inside Docker. Applying the same ownership preparation to the isolated checkout made the frozen installation pass, followed by the language check, TypeScript, and **111 passing tests**. No tooling image rebuild was needed. Probe services and volumes are separate from the development environment.

## 2026-10-12: LED MQTT protocol, gateway, and runtime

Observed RED against explicit stubs: protocol/session suite 26 failed / 1 passed, six real MQTT/PostgreSQL integration tests failed, and five runtime scheduler tests failed. A journal test reproduced a missing monotonic deadline; another reproduced a gateway consuming another output's pending command. Implemented versioned bounded frames, clock/session handshake, retained-frame rejection, conservative device deadlines, scoped claims, and a serial headless worker.

Real transport testing exposed a snapshot timestamp captured separately from its lease anchor; capturing it once fixed the handshake without relaxing freshness limits. Additional tests cover device reboot, gateway restart, live retained writes, and runtime lifecycle races. The latter reproduced two failures before the restart/cancellation fixes.

Final `make test`: **156 passed in 8 files**, including 9 MQTT integration tests and 24 journal tests; TypeScript and the language guard passed. Images were not rebuilt; the two new workspace packages and lockfile were installed in Docker. API/authentication, deployment processes, offline distribution, hardware verification, and editors remain pending; M0 is not yet complete.

## 2026-10-12: Local authentication and catalog API

Initial Docker RED: **15 failed** across credential and API suites against explicit stubs. Implemented scrypt credentials, serialized local administrator bootstrap, PostgreSQL sessions/audit, strict Fastify schemas, Origin/CSRF enforcement, login throttling, cursor-paged catalogs, project revision preconditions, and the authenticated command route. A non-ASCII forged CSRF token reproduced HTTP 500 instead of 403; validating its encoded form before constant-time comparison fixed the regression.

Added migration drift/bootstrap concurrency, rejected-command idempotency, and an authenticated API → real PostgreSQL → real MQTT → virtual LED → Verified scenario. Final `make test`: **175 passed in 10 files**, TypeScript and language checks passed. Compose configurations validated. The API starts under `tsx watch`; touching its entry file produced a restart and a passing container health request without an image build.

The development API uses host port 3100 because another existing application occupies port 3000. Its PostgreSQL volume is persistent and separate from temporary test storage. Broker/TLS deployment, runtime commissioning, web UI, offline delivery, and the rest of M0–M5 remain pending.

## 2026-10-12: Responsive web workspace and browser TDD

Observed RED: all **3 Chromium scenarios failed** against the initial page because the login fields were missing. Added the React workspace with authentication, projects, device registration, signal quality, cursor pagination, audit navigation, theme persistence, and responsive layouts.

Final `make test`: **175 unit/integration tests and 3 browser tests passed**, along with TypeScript, the English-content guard, and a Vite production build. Browser tests use the real API and PostgreSQL in an internal Docker network, verify no external asset requests, and check desktop, 360 px phone, and 768 px tablet layouts. Desktop/light-theme/mobile screenshots were inspected. Browser authentication uses an isolated fixture account, not a development default password.

The normal development workspace runs at http://localhost:5173. Both development services are healthy; editing the React entry point produced a Vite HMR update without rebuilding images. The pinned Playwright browser image is a separate one-time pull. `make test` now includes browser checks, so the existing CI command runs them as well. Physical outputs remain uncommissioned; neither editor nor the complete offline bundle is implemented yet.

## 2026-10-12: Basic graph/HMI editors and isolated simulation

Observed RED against explicit domain stubs: **17 failed / 3 passed** for logic, **5 failed / 2 passed** for HMI/history. Seven API integration scenarios then failed because the editor routes did not exist. The browser workflow failed waiting for the missing Logic navigation entry.

Implemented deterministic validated boolean graphs, monotonic timers, volatile latch/debounce state, Auto/Manual interlocks, bounded scene/history models, transactional editor drafts, and immutable prepared revisions. Added React Flow graph interaction, SVG scene editing, bindings, undo/redo, JSON editing, and a virtual-time simulation bench with no command-service dependency.

Browser testing found a saved draft incorrectly remained dirty after PostgreSQL reordered JSONB keys. A new history regression reproduced the same issue; canonical object-key comparison fixed both. Added migration-upgrade preservation, actual cross-project binding rejection, immutable database revision enforcement, and bounded/reversed-time simulation checks.

Final `make test`: **212 unit/integration tests and 4 Chromium scenarios passed**, plus TypeScript, the language guard, and the production frontend build. The browser scenario saves/prepares/simulates a graph, edits an HMI with undo/redo, reloads the browser, and reopens the persisted scene. Logic/HMI screenshots were inspected. Dependencies were installed into both development/test volumes without an image rebuild.

This completes the basic editor increment, not M0 or M1 as a whole. Live runtime activation, physical LED commissioning, firmware/HIL, alarms/history, backups, and offline distribution remain pending. See the precise supported contracts and limitations in `docs/editors.md`.
