# Code structure and change boundaries

The repository separates browser interaction, authenticated application workflows, pure contracts and external transports. Refactoring is incremental so that command ownership, revision checks and process boundaries retain their regression coverage.

| Location | Responsibility |
| --- | --- |
| `apps/web/src/features/projects` | Project routing and scoped workspace guidance |
| `apps/web/src/features/catalog` | Revision-aware catalog metadata editing |
| `apps/web/src/features/ai` | Explicit external-context consent and proposal preview/application |
| `apps/web/src/features/editors` | Graph/HMI canvases, shared editor model and archive trend presentation |
| `apps/web/src/editors.tsx` | Draft lifecycle orchestration, inspector, simulation and revision workflows |
| `apps/web/src/main.tsx` | Authenticated shell, navigation and catalog orchestration |
| `apps/api/src/*-api.ts` | Resource HTTP workflows, authorization, bounded input and audit |
| `apps/api/src/ownership.ts` | Shared project-owner boundary |
| `apps/api/src/document-validation.ts` | Shared graph/HMI schema and project signal-binding validation |
| `apps/api/migrations` | Append-only application schema migrations with checksum verification |
| `packages/domain/src` | Pure logic, document editing, signal, alarm, history and command contracts |
| `packages/storage` | Durable command journal, outbox and reconciliation |
| `packages/gateway` | Runtime ownership, MQTT device sessions, telemetry and simulator implementations |
| `packages/script-runtime` | Isolated bounded JS/TS execution |
| `packages/report-renderer` | Bounded PDF generation in a separate service |
| `packages/notifications` | Validated local notification transport contracts |
| `packages/firmware-tools`, `firmware` | Firmware provisioning, portable C core and ESP-IDF application |
| `packages/bench`, `tests/hil` | Opt-in instrumented/load tooling, separate from normal browser acceptance |
| `tests/integration`, `tests/e2e` | Real service boundaries and browser workflows in Docker |
| `docs`, `scripts`, `docker` | Contracts/evidence, operational tooling and container definitions |

Pure editor transforms are tested without React. Canvases render documents and report deliberate edits; they do not publish revisions or issue device commands. HTTP document validation is reusable by persistence and optional proposal generation. It does not substitute for runtime interlocks or equipment qualification.

Feature extraction does not mean the application shell and editor orchestration are finished abstractions. Avoid moving files solely to reduce line counts; extract an independently understandable responsibility with preserved tests. Dependencies remain pinned, source remains bind-mounted for development, and secrets/generated artifacts remain outside tracked product code.
