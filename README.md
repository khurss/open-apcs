# Open APCS

An open automation platform with a web interface, an HMI editor, and an executable logic editor. Designed to run locally on Linux in Docker without mandatory internet access. The first target device is ESP-WROOM-32.

The M0 foundation is implemented for the Linux x86-64 engineering profile: the signal model, command lifecycle, virtual LED with a watchdog, a PostgreSQL command journal with a transactional outbox, and a tested MQTT LED gateway/simulator with a headless runtime library. A local authenticated API and basic project/device catalog are also available. TypeScript checks and unit/integration/browser tests and the frontend build run in Docker; watch mode picks up changes without rebuilding images. The responsive English web workspace provides local login, projects, devices, signal quality, and audit views with light/dark themes. Basic graph and HMI editors now support saved drafts, undo/redo, prepared revisions, structural comparisons, audited draft restoration, and isolated boolean-logic simulation. Virtual devices can now be started from the UI and controlled through a separate server process and the durable MQTT command path. See [runtime operation](docs/runtime.md). Prepared graphs now execute headlessly with controlled revision switches and exclusive output ownership. Prepared HMI screens display current values and share the audited command panel; virtual Unknown outcomes have an explicit recovery workflow. Raw signal history now records changes and quality independently of the browser; see [history operation](docs/history.md). Durable boolean/quality alarms now support acknowledgement and timed suppression; see [alarm operation](docs/alarms.md). An ESP-IDF LED firmware build and native protocol checks are now included; see [firmware scope](docs/firmware.md). Explicit TLS bench commissioning is available through a private allowlist and operator review; see [commissioning scope](docs/physical-commissioning.md). Physical hardware acceptance remains pending. See [editor contracts](docs/editors.md). See [API startup](docs/api.md). See [development and hot reload](docs/development.md), the [TDD log](docs/tdd-log.md), the [command storage contract](docs/command-journal.md), and the [LED network contract](docs/led-network.md).

```bash
cd open-apcs # If your current directory is the parent APCS directory.
make image
make install
make test
make watch
```

Run `make install-dev && make dev` to open the workspace at http://localhost:5173. Create the initial administrator using the local command in [API startup](docs/api.md); there is no default login. React uses Vite HMR and the API uses process watch.

Use `make backup` for a local PostgreSQL archive. A prepared offline engineering bundle can install and test this workspace without package downloads; see [distribution and recovery](docs/distribution.md). New bundles include the pinned ESP32 toolchain; the production distribution remains pending.

The specification is based on an analysis of the legacy supervisory control system and a 40-question requirements interview. The project name, Open APCS, was chosen by the customer.

| Document | Contents |
|---|---|
| [Specification](docs/specification.md) | Purpose, scope, functional requirements, and interface |
| [Architecture and contracts](docs/architecture.md) | Stack, runtime, data model, commands, API, deployment |
| [Protocols and devices](docs/devices-and-protocols.md) | Integrations, ESP32, SDK, and simulation |
| [TDD and acceptance](docs/testing-and-acceptance.md) | Docker tests, failure scenarios, load, and completion criteria |
| [Development phases](docs/roadmap.md) | Implementation sequence and phase gates |
| [Decisions and open questions](docs/decisions-and-questions.md) | Customer answers, recommendations, and unresolved decisions |
| [Legacy analysis](docs/legacy-analysis.md) | Functions identified in the legacy system and Pascal source references |
| [Technical sources](docs/sources.md) | Primary documentation for technologies and integrations |

All repository documentation, source comments, UI text, and commit messages must be in English. User-defined data retains Unicode support. `make test` checks repository text for Cyrillic before running TypeScript and tests. Confirmed requirements, architectural recommendations, and open parameters are distinguished in the specification; an unspecified parameter is not an approved decision.

Publication target: [khurss/open-apcs](https://github.com/khurss/open-apcs). Completed implementation phases must be documented, checked in Docker, committed, and pushed. See [contributor instructions](AGENTS.md). The open-source license remains an explicit open decision; no license has been selected yet.

JS/TS boolean blocks are edited in Logic and run by a separate bounded Docker service. See [script execution and current limits](docs/script-runtime.md).
