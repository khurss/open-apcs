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

## 2026-10-12: PostgreSQL recovery and minimal offline distribution

Observed backup RED: the Docker recovery drill failed because the stub produced no archive. Implemented custom-format dumps with restricted file permissions and checksum sidecars, plus a transactional restore that only creates new databases. The real PostgreSQL drill verifies data/schema preservation, revision immutability, overwrite refusal, and corruption rejection before database creation. A separate backup of the development database was created under ignored `dist/backups`.

Observed offline RED: a fresh source copy and empty dependency/store volumes in a `network_mode: none` container could not import Vitest after the installer stub. Implemented locked installation from the prepared pnpm archive. The same networkless container then passed TypeScript, the frontend build, and **153 unit tests**. Added a fresh-volume/no-network dependency/build check to every `make test` run.

Built engineering bundle source tree `86c5441baef0` (about 1.4 GiB), containing source, package cache, and four local images. Installed it into a new workspace with distinct Compose volumes; pnpm installed 196 packages with **zero downloads**. Its API/UI became healthy on loopback ports 13100/15173. The exported workspace passed **212 unit/integration tests, 4 Chromium scenarios, TypeScript, the English guard, frontend builds, the networkless dependency check, and the PostgreSQL recovery drill**. Its test project cleaned up normally. The normal workspace independently passed the expanded `make test` command as well.

The source-tree identifier describes the tested exported snapshot, not a release commit. Subsequent changes in this increment only update documentation and use UUID fixture-database names to avoid collisions between concurrent recovery drills. No tooling images were rebuilt. This satisfies the minimal offline M0 engineering gate; firmware caches, production provisioning/signing, live runtime commissioning, and hardware verification are not implied. The distribution was exercised on the current Docker host with imported local image archives, not on a second physical machine with an empty image cache.

## 2026-10-12: Private runtime process and web control of virtual LEDs

Observed RED: five catalog/runtime tests failed against the service stub; the real-IPC scenario failed against its client stub; the API commissioning scenario returned 404; the browser scenario could not find Start simulator. A separate transport test timed out because the gateway confused a catalog device ID with its MQTT address. Added an explicit protocol address and retained the catalog identity for signal sessions.

Implemented a private bounded IPC worker, demand-only virtual device startup, workspace ownership through a PostgreSQL session lock, current project-policy reads, and the existing serial MQTT/journal dispatcher. Physical profiles are rejected, and each virtual startup uses a random simulation namespace. Added audited start/stop routes and web controls that distinguish command acceptance from Verified acknowledgement.

Fault testing kills the worker process, terminates its PostgreSQL ownership session, and injects a failed completion-audit write. The ownership-session test initially exposed a misleading stopped status; it now reports faulted and requires service restart. Pending intents are retired on stop and a restarted simulator has a new boot/OFF state. No startup path automatically rearms a device.

Final expanded `make test`: **221 unit/integration tests and 4 Chromium scenarios passed**, plus TypeScript, the English guard, frontend build, networkless dependency installation/build, and PostgreSQL backup/restore. A focused browser rerun captured and verified the manual-control screen after a real Verified result. Touching the worker source restarted the development API under tsx watch and reran the integration watcher; **68 integration tests passed**. The UI/API and isolated development broker are healthy without an image rebuild.

This is a virtual-device runtime delivery within M1. Live graph activation, physical firmware/HIL, production broker authentication, explicit Unknown reconciliation, and the remaining M1–M5 scope are still pending. The previously tested offline artifact remains its recorded source-tree snapshot; the bundle builder now also maps the simulation broker to its exported local image for future bundles.

## 2026-10-12: Prepared graph activation in the private worker

Observed RED: 16 scheduler cases failed against the initial stub; two additional lifecycle cases then reproduced concurrent scheduler starts and an unbounded stalled cycle. The final scheduler suite passes 18 cases with virtual time. Four PostgreSQL/MQTT activation cases failed against the runtime stubs, the API scenario failed with the missing route, and Chromium timed out waiting for the absent Activation reason field. Implemented bounded serial scheduling, journal-backed output intents, exclusive activation ownership, validated immutable revisions, command draining during revision switches, audited API operations, and editor controls.

Final `make test`: **246 unit/integration tests and 4 Chromium scenarios passed**, with TypeScript, the English-content check, frontend build, networkless fresh dependency installation/build, and PostgreSQL backup/restore. Integration checks include preserved device sessions during a revision switch, rejection of invalid/corrupt revisions without interrupting the old graph, competing/manual owner rejection, and generation-scoped compensation after audit failure. Chromium starts prepared logic, reloads the browser, confirms the same active revision, and stops it. The resulting editor screenshot was inspected.

No development image was rebuilt. M1 remains partial: execution targets virtual devices, active authority is volatile, and physical firmware/HIL, operator HMI control, history/alarms, Unknown reconciliation, and subsequent roadmap features remain pending. Unexpected feedback drift after command verification has no dedicated divergence alarm yet.

## 2026-10-12: Prepared HMI operator view

Observed RED: Chromium timed out waiting for the missing Operate revision action. Added an operator view of immutable prepared screens, current value/quality indicators, touch and keyboard controls, and the shared audited command panel. Reads have bounded concurrency/deadlines; failed reads preserve the last value with Disconnected quality, and the browser independently ages unrefreshed Good samples to Stale.

`make test` passed **246 unit/integration tests and 4 Chromium scenarios**, TypeScript, the English guard, frontend build, offline install/build, and backup/restore. The expanded browser workflow verifies a disconnected control is disabled, an HMI command reaches Verified and ON, network loss preserves ON with Disconnected quality and disables control, reconnection restores Good, and OFF works from a 360 px phone layout. A browser rerun passed all 4 scenarios after making screenshot capture wait for the responsive sidebar transition. The mobile operator screenshot was inspected. No images were rebuilt.

This completes the basic virtual HMI operator path, not the full M1 release. Persistent landing-screen assignment, faceplates, physical hardware commissioning, history/alarms, and subsequent roadmap scope remain pending.

## 2026-10-12: Explicit Unknown reconciliation

Observed RED: 14 PostgreSQL recovery cases failed because reconciliation was absent. The API test failed on the missing history route. After correcting two browser-fixture setup errors (test database credentials and the API package working directory), the browser test reached the intended failure: a persisted Unknown command was not shown when reopening control. Implemented a new, checksum-tracked migration, transactional recovery receipts, owner/quality/new-boot/OFF checks, bounded trusted-context resolution, idempotency, atomic audit, paged command history with an independent blocker lookup, and explicit recovery controls.

Final `make test`: **261 unit/integration tests and 5 Chromium scenarios passed**, plus TypeScript, English-content validation, frontend build, offline fresh-cache installation/build, and backup/restore with the new migration. Tests preserve the original Unknown outcome, reject unsuitable observations, roll back failed audit, release transaction locks after resolver timeout, upgrade a version-1 database, and ensure old blockers remain visible behind newer rejected requests. The browser injects an isolated durable dispatch loss, recovers through the actual worker/MQTT simulator, and verifies a separately issued new command while the original still remains Unknown with its receipt.

No source-change image rebuild was needed. Recovery is deliberately limited to virtual LEDs; physical safe-state commissioning and the remaining M1–M5 work are not completed by this increment.

## 2026-10-12: Headless raw signal history

Observed RED: five signal-observer tests failed on the absent subscription API; seven bounded-buffer cases and six PostgreSQL archive cases failed against stubs. Runtime tests found no persisted observations and no archive diagnostics. The API route was missing, and Chromium timed out on the absent History button. Added isolated synchronous observation callbacks, a bounded change/checkpoint buffer, transactional idempotent history storage, a private-worker recorder and seven-day raw retention maintenance, authenticated paged queries, and a history panel. The non-overlap test was corrected to wait for the intentionally deferred writer before releasing its fixture promise.

Final `make test`: **282 unit/integration tests and 5 Chromium scenarios passed**, together with TypeScript, the English guard, frontend build, offline fresh-cache installation/build, and backup/restore. Archive failure did not stop a separately Verified control command. A further backup drill restored an actual history sample after the fixture was extended. A focused Chromium rerun verified ON and Disconnected in the persisted history table and captured the inspected history screenshot.

The development API was restarted once to adopt the expanded source-watch pattern; subsequent API/worker/history changes use hot reload without image rebuilding. The archive has a volatile 4,096-observation buffer with visible drop/failure counters, a 60-second checkpoint, and bounded maintenance. Annual aggregates, historian gap/clock-discontinuity handling, incident capture, alarm lifecycle, firmware/HIL, and full scale acceptance remain pending. This is basic raw history within partial M1, not the complete retention or production historian release.

## 2026-10-12: Durable alarm lifecycle and operator actions

Observed RED: domain lifecycle cases failed against the initial stub; six PostgreSQL monitor cases failed on the missing implementation. The API test found no alarm route, and Chromium timed out on the absent Alarms navigation. Implemented boolean/quality conditions, monotonic delays and suppression, occurrence-aware acknowledgement, restart restoration, transactional state/events/audit, bounded rule creation, and the operator page. A browser accessibility lookup exposed a select-label ambiguity; explicit accessible names resolved it.

Final `make test`: **304 unit/integration tests and 5 Chromium scenarios passed**, plus TypeScript, English validation, frontend build, offline fresh-cache install/build, and backup/restore including persisted alarm state and events. The browser workflow covers disconnected activation, acknowledgement while the cause persists, suppression/removal, and return to Normal after actual MQTT simulator reconnection. The alarm screenshot was inspected; a subsequent spacing-only adjustment adds the existing content padding class.

No application image was rebuilt. This adds basic alarms to partial M1. Physical firmware/HIL, passive monitor autostart, notification delivery, numeric alarms, event retention policy, and later milestones remain pending. See [alarm contracts and limitations](alarms.md).

## 2026-10-12: ESP32 firmware core, cross-compilation, and provisioning preparation

Observed RED: the portable C stub failed 174 of 207 checks; after implementation the JSON codec stub failed 9 of 20 checks. Implemented bounded boot/session/lease state, no-repeat command handling, clock fault behavior, strict JSON decoding, and retained-message rejection. Sanitized native runs now pass all **227 assertions**. The cross-language harness initially exposed a Node fixture URL/path error; after fixing that fixture, its two comparisons pass against the TypeScript peer. Provisioning tests observed two semantic failures before implementation; all five now pass.

The ESP-IDF application adds explicit NVS configuration, an allowlisted GPIO, WPA2 Wi-Fi, local SNTP, verified TLS/MQTT 5, bounded ingress/outbox, an independently ticked control task, and task watchdog reset. These hardware-facing bindings are cross-compiled, not HIL-verified. The working application image is **0xe7fb0 bytes** and fits the default 1 MiB application partition with 9% remaining. A test-only certificate/configuration drill generated a 24,576-byte NVS image; the private wrapper produced mode 0600. No physical flashing occurred.

`make test` passed **311 unit/integration tests, 5 Chromium scenarios, 227 native firmware assertions, and ESP32 cross-compilation**, plus TypeScript, English validation, frontend build, offline dependency installation/build, and database backup/restore. Sources use bind mounts; ordinary firmware edits are incremental and `make firmware-watch` provides repeat checks without rebuilding the tool image. The pinned ESP-IDF image was downloaded once. Bundle scripts now include that toolchain; a fresh distribution drill is tracked separately.

This is an engineering firmware increment within partial M1. Physical gateway commissioning, broker ACL deployment, guided USB recovery, OTA, hardware timing and L0 acceptance remain pending. The first firmware profile also has a documented 128-applied-command-per-boot bound and explicit restart after network faults. These limits are not the intended long-running production profile.

## 2026-10-12: Explicit TLS LED bench commissioning

Observed RED: three physical-runtime cases failed on the absent commissioning operation; the private IPC test then failed on the absent client method. Private configuration-file tests rejected the stub, and the HTTP test failed on the missing commission route. Implemented a bounded private allowlist/CA configuration, explicit GPIO review, old-intent cancellation before arming, an initial OFF check, private-worker commissioning and audited owner-only API operations. Wrong certificates/passwords and topic ACL denial were additional baseline transport checks; they passed without changes to MQTT.js TLS behavior.

The first browser attempt exposed an incorrect exact label lookup for the existing profile select. The corrected fixture uses its accessible combobox name and then failed on the absent Arm LED bench button, establishing the browser RED. Integration assertions use a three-second command deadline consistent with the existing runtime tests; the initial one-second poll was insufficient during concurrent fresh firmware compilation. Test suites sharing a fixed MQTT address are run serially, and browser fixtures have separate accounts and topics.

The firmware distribution drill completed independently against fixed source tree `81a06719c123`: a 5.1 GiB bundle installed into a fresh workspace and fresh dependency volumes, then passed all 311 TypeScript tests, five Chromium scenarios, 227 sanitized C checks, ESP32 cross-compilation and the remaining build/backup gates with internal or disabled test networks. This snapshot predates the commissioning changes above and is reported separately. The owner explicitly deferred connecting the physical board; no hardware acceptance or flashing is claimed.

Final commissioning `make test`: **327 unit/integration tests, 5 Chromium scenarios, 227 sanitized native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore. The browser tested a physical catalog profile against its own TLS simulator, including explicit GPIO review, Verified ON and disarming; its screenshot was inspected. No application image rebuild or board flashing occurred. M1 remains partial pending hardware and load gates; the physical board is deferred, so independent software work continues.

## 2026-10-12: Prepared revision comparison and draft restoration

Observed RED: six structural comparison tests failed against the stub; four API cases failed on missing routes; Chromium waited for the absent Compare revision 2 button. Implemented bounded JSON pointer comparisons, immutable checksum checks, owner/CSRF protection, optimistic draft matching and transactional restore/audit. An additional sparse-array case exposed a validation gap and was fixed before the final gate. Array order remains meaningful; returned changes never alias stored documents.

The focused API suite passed 15 cases, including concurrent restore, audit rollback, a deleted signal binding, both graph and HMI revisions, and preservation of the running graph's activation ID. Five Chromium scenarios passed; the editor workflow changed the draft, inspected the field difference, restored revision 2 as draft 4, and kept runtime revision 2 active. This is part of M2's versioning scope. Unprepared draft autosave history and whole-project rollback are not implemented by this increment.

Final `make test`: **338 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, plus TypeScript, the English guard, frontend/offline builds and backup/restore. The restoration screenshot was inspected. Source hot reload was retained; no application image was rebuilt. The previous commissioning commit `0144f5c` also passed hosted CI.

## 2026-10-12: Isolated JS/TS boolean graph blocks

Observed RED: three request-contract cases, three bounded-queue cases, seven real-container interpreter cases, five asynchronous graph cases, two HTTP-client cases and two editor/API cases failed against their missing behavior. Graph-task tests additionally failed for absent evaluator checks and late-result fencing. Chromium waited for the absent script block option. Implemented a dedicated resource-limited runner, QuickJS guest contexts, TypeScript transpilation, bounded HTTP client, asynchronous graph evaluation and the Properties source editor.

An adversarial source-body escape was accepted during validation; its failing test led to AST validation of the enclosing function. A 25 ms interpreter wall deadline was too sensitive under concurrent container load, so the interrupt budget is 100 ms, still within the independent 500 ms worker deadline. Deliberate worker termination tests wait for worker readiness before the next independent case; live runtime requests do not retry. The queue tests verify cancellation does not overlap an unfinished execution. Integration suites sharing this single interpreter are serialized.

Focused verification passed 25 domain cases, 22 task cases, seven real-container interpreter cases, two HTTP-client cases and 17 editor/API cases. The API workflow includes real TypeScript evaluation through private runtime IPC and refusal to prepare syntax errors or execute without an isolated service. The previous revision-restoration commit `c9018d8` passed hosted CI. The first full run passed 364 unit/integration cases and the build/backup gates; Chromium then found ambiguous label matching for the script language select and source textarea. Explicit accessible names corrected those UI defects. Final gates for this increment are recorded below after completion.

Completed gates: **364 unit/integration tests, 5 Chromium scenarios, 227 sanitized native C assertions and ESP32 cross-compilation passed**, together with offline fresh-cache installation/build and database backup/restore. After the two browser label fixes, all five Chromium scenarios passed, and TypeScript/English/frontend build checks were repeated. The script-editor screenshot was inspected; the textarea then received the existing theme colors and padding. Docker inspection confirmed the configured memory/CPU/PID/read-only/capability limits. Development services are healthy with bind mounts; no tool image was rebuilt. M2 remains partial; this is a stateless boolean scripting profile, not numeric/PID/ST support or hardware acceptance.

## 2026-10-12: Loaded history trend and typed CSV export

Observed RED: five history presentation/export cases failed against the stub, and Chromium failed on the missing trend image. Implemented deterministic observation/ordinal ordering, quality/session/gap-aware line segments, exact string preservation, bounded loaded-page CSV and a responsive SVG view. The export identifies its loaded-page scope and includes original quality/time/session metadata. Spreadsheet-like text metadata is neutralized, while JSON value encoding preserves string/int64/null distinctions. A negative-number/formula-string regression case checks that typed JSON values remain parseable.

No storage migration or new dependency was introduced. The raw seven-day archive remains unchanged; annual aggregates, complete report jobs, PDF and scheduled summaries remain future work. Final Docker gate results are recorded below after completion.

The first full history-view run exposed an existing recovery endpoint returning 500 when live context resolution exceeded its one-second journal deadline. A deliberately stalled resolver reproduced that failure. The endpoint now maps that exact timeout to blocked recovery (409); the test verifies the Unknown command remains unreconciled and subsequently exercises actual simulator recovery and atomic audit rollback. The deadline was not extended, no command is replayed, and unrelated internal errors retain their existing handling.

Final `make test`: **370 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore. Visual inspection exposed the global icon SVG height affecting the trend; explicit chart sizing and internal phone scrolling corrected it. TypeScript/build/language checks and all five browser scenarios passed after that style change. Three focused workspace scenarios then passed with a screenshot wait for the sidebar transition. Desktop and phone history screenshots were inspected, and the browser verified the downloaded CSV bytes. No tool image rebuild occurred. The preceding JS/TS commit `4af85d9` also passed hosted CI.

## 2026-10-12: Durable SMTP/webhook notifications

Observed RED: four configuration cases and five local transport cases failed against their initial stubs. Six PostgreSQL outbox cases then failed on missing persistence; a seventh background-worker case failed on the missing worker. The alarm workflow exposed an absent outbox record, the HTTP workflow returned 404 for its missing log endpoint, and Chromium failed on the absent delivery table. Implemented strict private routes, verified TLS, webhook HMAC, static SMTP MIME, transactional enqueue, bounded leases/retries/capacity, per-attempt outcomes and audited manual retry. Suppression and alarm audit rollback are exercised with actual PostgreSQL transactions.

Focused checks passed the transport, queue/worker, alarm and authenticated API cases. The browser fixture uses a local recipient that rejects the first attempt and then accepts a manual retry; it runs the real private notification process. No external recipient is configured and no tool image has been rebuilt. Final full Docker gates and visual review are recorded below after completion.

Final `make test`: **392 unit/integration tests, 5 Chromium scenarios, 227 sanitized native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend build, offline fresh-module/store installation/build and database backup/restore. The backup fixture includes pending delivery and attempt records. Additional queue checks verify eight lost-response attempts cannot become a ninth and terminal retention preserves active work. Desktop and phone delivery screenshots were inspected; the phone workflow verifies no page overflow.

The first full run stopped at strict TypeScript checks on nullable test fixtures; those assertions were corrected before the successful complete rerun. During hot reload, the development database correctly rejected edits to an already-applied notification migration. The original migration was preserved and service status added as migration 006; development upgraded without deleting records or bypassing checksum validation. Both dev services are healthy and no image rebuild occurred. The preceding history-view commit `1acb1ce` passed hosted CI. This delivers the notification engineering profile within partial M2, not hardware acceptance or the complete roadmap.

## 2026-10-12: Quality-aware minute/hour history aggregates

Observed RED: seven calculation cases failed against the kernel stub; four PostgreSQL cases failed on missing persistence. A late-data test then demonstrated that an already-pruned interval could be changed using incomplete source data. Added serialized retention admission, whole affected-hour/anchor preservation and protection while backfill or dependent jobs remain pending. The background-worker and annual cleanup cases failed on their stubs, and the HTTP aggregate case returned 404 before implementation.

The kernel now covers held-duration weighting, Good/invalid/Unknown time, digital transitions, exact counter arithmetic/reset semantics, tied timestamps and overflow-resistant means. PostgreSQL checks cover late-data dirtiness, idempotent retries, bounded overload, restartable backfill, protected raw data and annual cleanup. A private worker owns aggregation and maintenance independently of browser/device startup; counter profile selection remains pending beyond the kernel. Final web integration and full Docker gate results will be recorded after completion.

Final `make test`: **409 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and database backup/restore including aggregate/job data. The browser runs the real private aggregation process and verifies 30 seconds ON, 30 seconds OFF, 100% Good coverage, last value and expandable quality details. Desktop and phone screenshots were inspected; no page-width overflow was observed. Development services remain healthy with unchanged Docker images. The notification commit `d023c20` passed hosted CI.

An additional ordering test brought the calculation suite to eight passing cases after the full run. An attempted clock-step assertion was withdrawn because insertion order also represents legitimate late arrival; the corrected test verifies observation-time ordering. There is no inferred clock-epoch behavior in this increment. Explicit observation-clock epochs, counter profile configuration, numerical devices, capacity/disk-quota acceptance and complete reports remain pending. M1 hardware acceptance and the rest of M2–M5 are not complete.

## 2026-10-12: Typed numeric logic and hysteresis

Observed RED: ten kernel cases rejected the new block kinds, the task rejected a finite numeric sample, the catalog rejected a float64 input, and Chromium could not select Hysteresis. A separate multi-output test exposed an early command from a valid branch before division by zero in another output branch was checked. Added typed ports/bindings, finite arithmetic, comparisons, hysteresis/reset semantics and whole-output preflight before dispatch. Numeric actuator commands remain prohibited.

Focused Docker checks passed 55 kernel/task cases, strict TypeScript, numeric API simulation (including 0 and 1), and actual MQTT command verification. Unsupported analog activation now returns a specific 422 while preserving the running revision. The extended Chromium workflow passed numeric properties, connection type rejection, simulation traces, revision activation and phone width. A first browser test used an exact label locator that did not resolve the JSON textarea; using its textbox role reached the intended missing-block RED. Live-driver test fixture SQL was corrected before observing the intended rejection failure. No image rebuild occurred. Full gate and visual review results follow after completion.

Final Docker gates: **425 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore through migration 009. The first complete run passed every non-browser gate and four browser scenarios; the editor scenario then exposed a case-sensitive test locator for the existing Fit View button. Correcting that locator was followed by a successful complete five-scenario browser rerun. No application behavior changed after the non-browser gates. Desktop and phone numeric graph screenshots were inspected after spacing the example blocks and fitting the canvas. Development services remain healthy, with hot reload and unchanged tool images. The preceding aggregate commit `6ee20ef` passed hosted CI. Numeric hardware drivers, PID/counters and the remaining M1–M5 acceptance gates are still pending.


## 2026-10-12: Virtual thermal process and numeric HMI

Observed RED: five model cases failed against the stub; three actual-MQTT cases then failed against the adapter stub. Device registration returned 400 for the missing thermal profile, and an input command returned 202 instead of being rejected before journaling. A numeric HMI widget failed domain/API validation. Virtual-heater reconciliation initially rejected the unsupported profile rather than applying the existing safe-session checks. Implemented the sampled process, bounded numeric telemetry, two-signal registration, live analog graph bindings, read-only HMI values and explicit virtual-heater recovery.

Focused Docker checks passed 14 model/HMI cases and 27 editor/MQTT integration cases, including numeric history, two verified closed-loop heater commands, actual TCP interruption and recovery preserving Unknown. The initial browser attempt stopped at an exact label locator for Device profile; selecting its combobox role reached the implemented workflow. The full editor browser scenario then passed registration, thermostat template activation, numeric monitoring, numeric HMI and device-stop propagation. Implementation used the existing tool images and bind-mounted source. Final full gates and visual evidence follow after completion.

Final `make test`: **439 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore through migration 010. Numeric HMI review found that a value scaled with a large SVG scene was too small on a phone; a responsive Readings panel now provides the same value and quality at readable size. After a final padding adjustment, the frontend build and complete editor browser scenario passed again. Desktop and phone screenshots were inspected. Development services remain healthy with unchanged tool images. The preceding numeric-logic commit `aeaeaf1` passed hosted CI. This is simulator-tested functionality within partial M2; physical numerical drivers, firmware emulation, HIL and full load acceptance remain pending.

## 2026-10-12: Numeric threshold alarms

Observed RED: nine threshold lifecycle/validation cases failed before implementation, the durable numeric alarm timed out, its API creation returned 422, and Chromium could not select High threshold. Implemented finite float64 bindings, high/low hysteresis with inclusive trip and strict reset boundaries, both delays in the operator form, typed signal filtering and readable rule boundaries. The persisted active state determines the reset boundary after restart; unavailable input retains the occurrence and acknowledgement while cancelling pending delays.

Focused Docker checks passed 24 alarm kernel cases, 33 alarm/editor integration cases and the complete editor browser scenario. PostgreSQL tests verify restart, acknowledgement and transactional activation/return notifications. The browser creates and acknowledges a live thermal threshold alarm and verifies that stopping the device preserves the active alarm with unavailable input. The local notification fixture rejects its first delivery per project so independent browser scenarios retain their own retry lifecycle. A first TypeScript check found a package alias absent from this monorepo; the import now follows the existing relative source convention. No image rebuild occurred. Full gates and visual review follow after completion.

Final `make test`: **450 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore. Desktop and phone threshold-alarm screenshots were inspected; the browser verifies page-width containment. Development continues with bind mounts and unchanged tool images. The preceding thermal-process commit `aa0c421` passed hosted CI. Numeric alarm monitoring is simulator-tested; passive startup, alarm retention/flood handling, hardware acceptance and remaining M2–M5 features are still pending.

## 2026-10-12: Passive monitoring and supervised worker recovery

Observed RED: three integration cases failed on the absent passive-start/supervision methods, and Chromium could not find a running monitor before project or device creation. Added post-migration passive startup, exclusive workspace ownership and a ten-second supervisor using the existing bounded private IPC. Unstarted signals remain Disconnected; no device session or graph is restored. The alarm workspace now fetches global monitor status even when no project exists.

Focused Docker verification passed all 18 runtime integration cases and strict TypeScript. The new recovery case kills the worker after an MQTT graph drives ON, waits using database observations only, and verifies that monitoring resumes with device, graph and command ownership stopped. Separate cases enforce competing-owner rejection and shutdown after loss of the passive ownership session. Internal alarm persistence faults remain explicit and require service restart. No image rebuild occurred. Full gates follow after completion.

Final `make test`: **453 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore. The browser checks a running monitor before creating its first project and then completes the existing control/editor/alarm workflow. Development services remain healthy under hot reload. This adds passive recovery on the single-server engineering profile; it does not add automatic equipment rearming, HA or physical acceptance.

## 2026-10-12: Elapsed-time filter and bounded edge counter

Observed RED: eight stateful numeric kernel cases failed on unsupported nodes, the authenticated save returned 422, and Chromium could not select Counter. Added typed blocks, bounded parameters, elapsed-time exponential smoothing, saturating edge counting and editor properties. Initialization, reset priority, unavailable-input reset and non-retentive activation semantics are explicit. The filter avoids subtracting opposite-sign extreme values.

Focused Docker checks passed 38 logic kernel cases, strict TypeScript and a real PostgreSQL/MQTT editor workflow. The integration graph delays a rising edge, counts it, filters the count and compares it before issuing a verified boolean LED command; pure simulation creates no command records. These are sampled software blocks, not hardware pulse capture or persistent totalizers. No image rebuild occurred. Full browser and Docker gates follow after completion.

Final `make test`: **462 unit/integration tests, 5 Chromium scenarios, 227 native C assertions and ESP32 cross-compilation passed**, together with TypeScript, English validation, frontend/offline builds and backup/restore. Desktop and phone screenshots were inspected. Phone review found help text sharing a narrow grid cell with Delete; explanations and the action now span the Properties panel width. The frontend build and complete editor browser scenario passed after that CSS adjustment. The preceding passive-monitoring commit `2d8c153` passed hosted CI. No tool image was rebuilt. PID, retentive/hardware counters, hardware acceptance and remaining roadmap features are still pending.
