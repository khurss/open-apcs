# Product acceptance and defect review

This record accompanies the P1–P5 delivery plan in [the roadmap](roadmap.md). Browser exploration and automated regression tests complement one another. A section rendering successfully does not establish that every action within it works.

## Baseline: 2026-10-13

Docker Chromium opened the deployed LAN application with certificate pinning and a real authenticated session. All nine navigation sections rendered on desktop (1440 px) and phone (390 px). No browser page exception or horizontal page overflow was observed. Projects had **zero actionable project rows**, reproducing the reported navigation defect. Screenshots and machine-readable observations are retained privately under `.cache/acceptance/baseline/`; they contain existing installation names and are not product marketing assets.

Confirmed findings:

| Finding | Impact | Resolution |
| --- | --- | --- |
| Several original catalog, document and command routes checked authentication but not project ownership | Another authenticated owner could read or mutate foreign resources, including requesting a virtual runtime stop | P1 adds owner-scoped SQL and transactional owner checks; PostgreSQL regression verifies hidden lists, rejected reads/writes and unchanged foreign data |
| Project rows cannot be opened | Users cannot enter a project workspace | P2 |
| Devices and signals mix every loaded project | Context is unclear; large catalogs obscure relevant equipment | P2 |
| No installed example with prepared logic and screens | First-time users must construct the whole workflow before evaluating it | P2 |
| System copy says physical commissioning is pending despite the implemented LED bench | Misleading capability description | P2 |
| Editors and the application shell contain several responsibilities in long components | Changes are harder to review and maintain | P3 |

Ownership review also inspected history, aggregates, alarms, notifications, physical commissioning, graph execution, command recovery and reports. Their resource routes already perform owner checks. This review is not a claim that every possible security defect has been eliminated. The current product still bootstraps one operator; owner isolation protects the existing data contract and future account expansion.

## Acceptance matrix

P5 records fresh results against the completed delivery. Existing automated coverage is listed here as a baseline, not a substitute for that final run.

| Journey | Baseline evidence | Final delivery |
| --- | --- | --- |
| Login, failure, session, logout | `workspace.spec.ts`, API integration tests | Pending |
| Projects create/open/rename; reload/back; scope/search | Create covered; open defect reproduced | Pending P2 |
| Demo install/reopen; virtual start/stop | Not implemented at baseline | Pending P2 |
| Device registration; simulated and LED commissioning controls | `workspace.spec.ts`; physical tests are separate opt-in evidence | Pending |
| Signal values, quality, manual receipts/recovery, history | `workspace.spec.ts`, `signal-monitor.spec.ts`, `recovery.spec.ts` | Pending |
| Graph editing, validation, simulation, revision preparation/activation | `editors.spec.ts`, runtime integration tests | Pending |
| HMI editing, operator controls, numeric readings and trends | `editors.spec.ts`; embedded trends planned | Pending P3 |
| Alarm lifecycle, suppression and notification inspection/retry | `workspace.spec.ts` | Pending |
| Raw CSV, aggregate views, daily/monthly CSV/PDF reports | `workspace.spec.ts`, report integration tests | Pending |
| Audit and System sections | LAN browser exploration | Pending |
| Dark/light theme; desktop/phone/tablet; keyboard navigation | Existing workspace and editor browser tests | Pending |
| Optional AI proposal, validation, preview and draft application | Not implemented at baseline | Pending P4; external call requires private credentials |
| Source/private-file isolation and no unexpected network calls | `dev-boundary.spec.ts`, workspace browser tests | Pending |

Hardware fault/endurance results remain in [the bench](rigol-hil.md) and [L0 measurements](load-l0.md). Ordinary browser acceptance must not silently arm existing physical equipment. SMTP/webhook transport tests use local fixtures. Unimplemented roadmap protocols and scale targets cannot receive a browser pass.
