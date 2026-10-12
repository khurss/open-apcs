# Open APCS

An open automation platform with a web interface, an HMI editor, and an executable logic editor. Designed to run locally on Linux in Docker without mandatory internet access. The first target device is ESP-WROOM-32.

Part of M0 is implemented: the signal model, command lifecycle, virtual LED with a watchdog, and a PostgreSQL command journal with a transactional outbox. TypeScript checks and unit/integration tests run in Docker; watch mode picks up changes without rebuilding images. The web application and connection to a physical ESP32 are still pending. See [development and hot reload](docs/development.md), the [TDD log](docs/tdd-log.md), and the [command storage contract](docs/command-journal.md).

```bash
cd open-apcs # If your current directory is the parent APCS directory.
make image
make install
make test
make watch
```

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
