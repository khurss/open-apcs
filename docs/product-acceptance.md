# Product acceptance and defect review

This record accompanies the P1–P5 delivery plan in [the roadmap](roadmap.md). Browser exploration and automated regression tests complement one another. A section rendering successfully does not establish that every action within it works.

## Baseline: 2026-10-13

Docker Chromium opened the deployed LAN application with certificate pinning and a real authenticated session. All nine navigation sections rendered on desktop (1440 px) and phone (390 px). No browser page exception or horizontal page overflow was observed. Projects had **zero actionable project rows**, reproducing the reported navigation defect. Screenshots and machine-readable observations are retained privately under `.cache/acceptance/baseline/`; they contain existing installation names and are not product marketing assets.

Confirmed findings:

| Finding | Impact | Resolution |
| --- | --- | --- |
| Several original catalog, document and command routes checked authentication but not project ownership | Another authenticated owner could read or mutate foreign resources, including requesting a virtual runtime stop | P1 adds owner-scoped SQL and transactional owner checks; PostgreSQL regression verifies hidden lists, rejected reads/writes and unchanged foreign data |
| Project rows cannot be opened | Users cannot enter a project workspace | Delivered in P2 |
| Devices and signals mix every loaded project | Context is unclear; large catalogs obscure relevant equipment | Delivered in P2 |
| No installed example with prepared logic and screens | First-time users must construct the whole workflow before evaluating it | Delivered in P2 |
| System copy says physical commissioning is pending despite the implemented LED bench | Misleading capability description | Delivered in P2 |
| Editors and the application shell contain several responsibilities in long components | Changes are harder to review and maintain | Feature/domain extraction delivered in P3; see code structure |

Ownership review also inspected history, aggregates, alarms, notifications, physical commissioning, graph execution, command recovery and reports. Their resource routes already perform owner checks. This review is not a claim that every possible security defect has been eliminated. The current product still bootstraps one operator; owner isolation protects the existing data contract and future account expansion.

## Acceptance matrix

P5 combines the automated workflows below with a fresh authenticated LAN browser walkthrough. The final aggregate gate is recorded in the TDD log.

| Journey | Baseline evidence | Final delivery |
| --- | --- | --- |
| Login, failure, session, logout | `workspace.spec.ts`, API integration tests | Passed |
| Projects create/open/rename; reload/back; scope/search | Create covered; open defect reproduced | Passed: `project-workspace.spec.ts`, project links and restored URL context |
| Demo install/reopen; virtual start/stop | Not implemented at baseline | Passed: idempotent API fixture, browser PID/start/stop path and installed LAN demo |
| Device registration; simulated and LED commissioning controls | `workspace.spec.ts`; physical tests are separate opt-in evidence | Passed with virtual/protocol fixtures; no physical rearming |
| Signal values, quality, manual receipts/recovery, history | `workspace.spec.ts`, `signal-monitor.spec.ts`, `recovery.spec.ts` | Passed: quality, history, commands and uncertain-outcome recovery |
| Graph editing, validation, simulation, revision preparation/activation | `editors.spec.ts`, runtime integration tests | Passed, including prepared execution and revision workflows |
| HMI editing, operator controls, numeric readings and trends | `editors.spec.ts`; embedded trends planned | Passed: `editor-tools.spec.ts`, history outages/recovery, phone axis readability, prepared LAN screen |
| Alarm lifecycle, suppression and notification inspection/retry | `workspace.spec.ts` | Passed with local notification fixtures |
| Raw CSV, aggregate views, daily/monthly CSV/PDF reports | `workspace.spec.ts`, report integration tests | Passed: browser downloads and report/aggregate contracts |
| Audit and System sections | LAN browser exploration | Passed in all six theme/viewport combinations; owner-scoped audit regression |
| Dark/light theme; desktop/phone/tablet; keyboard navigation | Existing workspace and editor browser tests | Passed: `presentation.spec.ts`, project keyboard navigation and LAN walkthrough |
| Optional AI proposal, validation, preview and draft application | Not implemented at baseline | Passed with local provider fixtures; real OpenAI call remains untested without private configuration |
| Source/private-file isolation and no unexpected network calls | `dev-boundary.spec.ts`, workspace browser tests | Passed; ordinary LAN walkthrough recorded no unexpected HTTP failures |

Hardware fault/endurance results remain in [the bench](rigol-hil.md) and [L0 measurements](load-l0.md). Ordinary browser acceptance must not silently arm existing physical equipment. SMTP/webhook transport tests use local fixtures. Unimplemented roadmap protocols and scale targets cannot receive a browser pass.

## Final LAN walkthrough and UX review: 2026-10-13

Docker Chromium completed **54 combinations**: nine sections, dark/light themes, and 1440, 768 and 390 px widths. It recorded zero page exceptions, zero unexpected HTTP errors and zero horizontal page overflow. The same session opened the prepared demo, activated its virtual PID, displayed Good operator readings/history, checked the unconfigured AI state, and captured public screenshots using demo data only. The existing physical ESP32 runtime was read as **stopped**. Private full-installation screenshots and machine-readable observations remain under `.cache/acceptance/final/`; the public gallery is in [screenshots](screenshots/README.md).

Additional confirmed defects were reproduced before repair:

| Finding | Regression and result |
| --- | --- |
| Late catalog failures overwrite a newer section's healthy status | A held request returns 503 after navigation; the new browser regression verifies no obsolete alert or disconnected indication |
| Phone trend labels shrink with the desktop viewBox | Rendered axis height was about 7.56 px; responsive plot geometry now measures about 14 px on the LAN phone view and is checked in the editor scenario |
| Full historian minimum width expands an embedded phone trend | P3 browser regression reproduced page overflow; bounded trend containers and mobile cards now fit |
| Shared browser fixtures assume a project is first in a list | Workspace/editor tests now enter their own project explicitly, preserving the real navigation behavior rather than relying on ordering |

The README uses an explicit product title, natural SCADA/HMI/ESP32 terminology, descriptive image text, useful links and reproducible startup steps, following [Google's SEO starter guidance](https://developers.google.com/search/docs/fundamentals/seo-starter-guide). Search indexing and ranking are outside the repository's control; no first-position result is claimed. The screenshots are direct browser captures, not mockups.

Acceptance covers implemented software and the specified fixtures. It does not certify equipment safety, every possible defect, every future protocol, a live external AI provider, complete production distribution or the 10,000-device target. Those boundaries remain visible in the roadmap and product README.

Final aggregate verification: `make test` exited 0 with 588 unit/integration cases and 13 Chromium scenarios, plus the native firmware, cross-build, recovery, offline and backup gates. See [the detailed TDD record](tdd-log.md). No Docker image rebuild was needed for these source changes.
