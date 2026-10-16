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

## Thermal recipe preview

`packages/domain/src/recipe.ts` defines the legacy isolated thermal state machine.
`recipe-program.ts` validates and executes version-2 ordered Heat/Hold/Cool steps
while dispatching legacy snapshots unchanged.
`apps/api/src/recipe-api.ts` owns authorization and immutable version/run routes;
`recipe-service.ts` serializes persistence and schedules server simulation.
`apps/web/src/features/recipes/workspace.tsx` provides version publication, run
controls and journal inspection. This path has no physical command dependency.

`packages/gateway/src/recipe-task.ts` runs measured thermal recipes with command
verification and a watchdog. `runtime-service.ts` resolves exclusive output
ownership and connects the task to MQTT, durable commands and conditional run
persistence; `runtime-process.ts` exposes private IPC. `recipe-demo.ts` installs a
dedicated virtual chamber and prepared HMI without activation. The operator
monitor under `features/recipes` displays project-level MQTT run state.

## Universal recipes

`packages/domain/src/recipe-model.ts` is the shared facade over legacy thermal,
ordered thermal and schema-version-3 universal definitions. `universal-recipe.ts`
validates roles/steps and advances the pure sequential state machine;
`recipe-presets.ts` supplies independently editable examples.
`packages/gateway/src/universal-recipe-task.ts` owns verification, final OFF for
all outputs, watchdog and cancellation. `apps/api/src/recipe-bindings.ts` resolves
same-project typed virtual signals; `runtime-service.ts` reserves the complete
output group before execution. `universal-recipe-demo.ts` installs idempotent
content backed by migration 019. Web components `universal-editor.tsx` and
`universal-launch.tsx` separate preset/step editing from explicit signal binding
and device startup. Existing recipe HMI status and persistence serve all formats.
