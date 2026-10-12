# Open APCS Specification

Version 0.1, October 12, 2026. Status: initial specification based on source analysis and 40 stakeholder answers, with engineering recommendations explicitly identified. This document defines implementation requirements; unresolved parameters are listed in the [decision register](decisions-and-questions.md). Repository documentation is maintained in English.

## 1 Purpose and scope

Open APCS is a universal local automation platform combining SCADA supervision, HMI, device integration, and process logic execution. Industry-specific functionality is delivered as libraries of symbols, blocks, devices, and projects.

Mandatory stakeholder requirements:

- A complete web application with a modern interface, English text, light/dark themes, and responsive layouts.
- Two connected editors: HMI screens and executable logic. Logic includes nodes/edges, FBD/SFC, a text editor, and custom JavaScript/TypeScript blocks.
- Linux servers; services, builds, and tests run in Docker. Application software uses TypeScript; other languages require justification.
- Operation without internet, external SaaS, CDN resources, external accounts, or mandatory telemetry.
- Installation, updates, firmware builds, and package installation also work offline using a prepared bundle.
- Logic executes on a server or Linux gateway; microcontrollers provide I/O and local fault behavior.
- ESP-WROOM-32 with LEDs is the first physical test bench. Support custom I/O firmware, ESPHome integration, web-based pin configuration, and OTA.
- Extend to popular ESP32, STM32/ARM, AVR/Arduino, and mbed families through documented profiles and adapters. Each supported board requires capability verification.
- Target scale after the first complete workflow: up to 10 sites, 10,000 devices in total, approximately 5–10 signals per device, and one active operator.
- Change-based history: raw values for 7 days, aggregates for 1 year.
- TDD from the first executable change, with tests running in containers.

The legacy supervisory system is a source of functionality. Migration of its binary projects, archives, DDE integration, and proprietary station protocols is not required.

“Universal” means an extensible model. It does not promise compatibility with every device without an adapter. Each shipped integration identifies its versions, limitations, and verification level.

## 2 Operating modes

| Mode | Purpose | Outputs to physical equipment |
|---|---|---|
| Design | Edit projects and validate references/types | Prohibited |
| Simulation | Virtual time, virtual devices, debugging | Architecturally prohibited |
| Commissioning | Check a selected device and individual outputs | Explicitly enabled outputs and actions only |
| Run | Execute a published revision | Through the authorized command service |
| Maintenance | Service selected equipment | Restricted policy with audit records |

Mode changes are audited. Starting a debugger or opening an editor does not stop the active runtime. Renaming a simulated signal or command cannot connect it to a physical driver.

## 3 Sites, devices, and signals

**FR-01 Projects and sites.** A project contains a hierarchy of sites, assets, devices, signals, screens, logic, schedules, alarms, and recipes. Identifiers remain stable across renaming. Deleting a referenced signal exposes its dependencies and prevents publication with broken references.

**FR-02 Devices.** An onboarding wizard selects the profile, gateway, protocol, address, connection options, and signal set. Provide batch creation, templates, signal CSV import/export, connection tests, diagnostics, firmware versions, and last-contact indication. Discovered devices first enter a pending-registration list.

**FR-03 Signals.** Support boolean, signed/unsigned integers, float, enum, and string. Represent 64-bit integers in JSON as decimal strings; JavaScript `number` does not precisely represent every int64. Signals include direction, unit, range, scaling, source, receipt/source timestamps, quality, maximum age, and history settings.

**FR-04 Quality.** Define explicit semantics for `Good`, `Uncertain`, `Bad`, `Stale`, `Disconnected`, and `Simulated`. Missing data never becomes zero. Show the last known value together with quality and age. Computed signal quality depends on its inputs.

**FR-05 I/O channels.** Initial custom firmware provides GPIO input/output and diagnostics. Add PWM/ADC and peripherals through profiles. Reserved or incompatible pins cannot be assigned without a conflict indication. Boot-pin restrictions belong to the specific board profile.

## 4 HMI screen editor

**FR-06 Canvas.** An SVG-oriented scene model supports pan/zoom, grid, snapping, box selection, movement, sizing, rotation, layers, groups, alignment, undo/redo, copy/paste, search, and keyboard commands. Raster images may be resources; executable code in imported SVG is prohibited.

**FR-07 Components.** Lines, pipes, labels, values, indicators, buttons, switches, sliders, tanks, valves, pumps, motors, trends, tables, and alarm feeds. Rendering reflects signal value, mode, and quality. Text/icons accompany color so state interpretation does not depend solely on color perception.

**FR-08 Bindings.** Bind components to signals and permitted actions in a properties panel. Configure formatting, units, ranges, visibility/animation conditions, and actions. Show type errors before publication. Buttons submit commands through the backend; widgets cannot address equipment directly.

**FR-09 Symbols and faceplates.** Reusable symbols expose parameters, ports, states, and equipment detail panels. A symbol version change requires a controlled project migration and publication before it affects a live screen.

**FR-10 Operator mode.** Screens link to equipment details, current values, history, alarms, commands, and diagnostics. Distinguish requested state from confirmed state. Phones support monitoring, acknowledgement, and permitted control; editors remain usable by touch within canvas-size constraints.

## 5 Logic editor and execution

**FR-11 Representations.** Node graphs, FBD function blocks, SFC sequences, and text blocks share stable signal identifiers and a common project model. A TypeScript script appears as a block with declared ports; arbitrary text-to-graph round trips are not promised. A future release must support Structured Text with a separately defined language subset. FBD/SFC/ST support alone does not imply full IEC 61131-3 compatibility.

**FR-12 Validation.** Before execution, validate port types/directions, units, required connections, missing resources, cycles without delay, conflicting output owners, and unsupported block versions. Feedback requires an explicit state/delay block.

**FR-13 Library.** The complete target release includes:

| Category | Blocks and behavior |
|---|---|
| Logic | AND/OR/NOT/XOR, comparisons, edges, latch, selector |
| Time | TON/TOF/pulse, debounce, rate limit, schedules |
| Mathematics | Arithmetic, formulas, scaling, filters, min/max, deadband |
| State | Counters, accumulators, memory, state machines |
| Control loops | Hysteresis, PID with output limits, anti-windup, bumpless transfer |
| Sequences | Steps/transitions, timeouts, abort, manual continuation |
| Commands | Command request, result waiting, interlocks, Auto/Manual selection |
| Operations | Recipes/parameters, events, alarms, local notifications |
| Extensions | Typed JS/TS blocks with execution limits |

All categories belong to the target specification. The [roadmap](roadmap.md) defines their implementation order; the initial demonstration does not have to complete the entire library.

**FR-14 Semantics.** Equal inputs, clocks, and state produce reproducible execution. Calculation order, timers, quality, restart, state restoration, and timing limits are specified in the [architecture](architecture.md). Each logic task has one runtime owner.

**FR-15 Scripts.** Provide syntax highlighting, types, diagnostics, and completion for the permitted SDK. Compile TypeScript locally. Scripts receive input snapshots, configuration, bounded private state, and virtual clocks; they return outputs and command intents. Network, filesystem, and arbitrary npm package access are disabled by default.

**FR-16 Debugging.** Live values and active-step highlighting, traces, simulation breakpoints/stepping, manual virtual inputs, and replay of recorded events. Pausing a debugger cannot silently stop physical equipment processing.

**FR-17 Recipes and schedules.** Version recipes, validate units/ranges, preview changes before applying them, and track results per device. Cross-device atomic transactions are not promised. Schedules specify timezone, DST policy, and missed-run policy. By default, missed control actions are not replayed after downtime.

## 6 Commands and fault tolerance

**FR-18 Unified command path.** Manual control, graphs, scripts, recipes, API calls, and schedules share permission, mode, input freshness, interlock, range, and output-ownership checks. Another protocol or screen cannot bypass a prohibition.

**FR-19 Fault behavior.** Each controlled output requires policies for startup, connection loss, runtime shutdown, and reconnection. Control remains disabled until configured. ESP32 runs its local watchdog and configured output behavior independently of browser, broker, and server. External-device profiles explicitly state whether they provide equivalent capabilities.

**FR-20 Retries and acknowledgements.** Commands have an ID, deadline, and state. Broker acceptance is not device execution; a GPIO state does not prove mechanical action. Show uncertain results as `Unknown`; do not automatically repeat dangerous non-idempotent actions.

**FR-21 Process safety.** Agreed boundary: the platform provides ordinary control and supervision; independent critical protections and emergency stops remain on hardware or suitable controllers. Architecture considers industrial cybersecurity and functional safety principles. No SIL compliance or certification is claimed; stakeholder answer 24 records this boundary.

## 7 Alarms, history, and diagnostics

**FR-22 Alarms.** Conditions, priorities, activation/return delays, hysteresis, connection state, and acknowledgements with user/time/comment. Acknowledgement neither removes the cause nor starts equipment. Provide site/asset filters, lifecycle history, and links to HMI screens and trends. Suppression requires a reason and expiry and is audited.

**FR-23 History.** Archive significant value/quality changes plus configurable checkpoint samples. Retain raw data for 7 days and aggregates for 1 year. Analog signals define deadband and maximum recording interval; deadband must not discard digital transitions or quality changes.

**FR-24 Aggregates.** Analog data: min/max, last value, sample count, valid-data duration, and time-weighted mean. Digital data: time in state and transition count. Counters: increments accounting for resets. `Bad/Stale` is not averaged as zero. Late data causes bounded recalculation of affected intervals.

**FR-25 Trends and incidents.** Multiple signals, time zoom, cursor, units, invalid-data gaps, command/alarm annotations, and CSV export. Incident capture stores selected signals before and after an event, with retention separate from the ordinary 7-day policy.

**FR-26 Operations.** Show service/gateway health, data age, delays, command queues, disk limits, broker/database health, event-loop lag, and backup results. Buffer exhaustion and data loss create diagnostic events.

## 8 User interface

Primary navigation: `Overview`, `Projects`, `Devices`, `Signals`, `Screens`, `Logic`, `Alarms`, `History`, `Simulation`, `System`. Selected-object details appear alongside the workspace with navigation back to the original context.

**UX-01** Initial workflow: create project → add physical/virtual ESP32 → assign GPIO → view signal → build logic → create screen → simulate → publish → explicitly enable control.

**UX-02** Always show environment (`Simulation`/`Live`), active revision, connection state, and unacknowledged alarms. Drafts and published configuration are distinguishable.

**UX-03** Both themes share design tokens. Editors support keyboard navigation, visible focus, clear labels, and sufficient contrast. Test 360, 768, and 1440 px viewports. Complex canvases may use pan/zoom; forms/navigation must not require horizontal scrolling.

**UX-04** Product labels, errors, and help are English. User-entered equipment names and comments support Unicode. The interface does not load fonts, icons, or editors from external CDNs. Repository documentation and authored assets also use English; Unicode input support does not require committing non-English fixtures.

## 9 Versions, access, and openness

**FR-27 Publication.** Save drafts separately. Validate → create immutable revision → trial run → activate on the assigned runtime. Publish an individual graph with its dependencies without stopping others; the active manifest pins all component versions. Failed loading retains the previous revision. Rollback never replays old commands or changes physical outputs without the applicable policy.

**FR-28 User.** Initially one active operator and one bootstrap local administrator account. User identity, action authorization, and auditing are mandatory; absence of collaboration does not imply anonymous access. Detailed roles and collaborative editing are later extensions.

**FR-29 Project format.** A documented package includes manifest, schema versions, signals, devices, graphs, screens, and resources. Export excludes secrets by default. Import checks size, paths, versions, signatures/checksums, and compatibility; importing alone activates nothing.

**FR-30 Open source.** Source availability covers the core, both editors, SDK, base drivers, simulator, and tests. Paid cloud services are not required for basic operation. Licensing, publication, and contribution rules are recorded separately. Legacy source/resources are not automatically included in the new distribution.

**FR-31 Notifications.** Local SMTP and configurable webhooks support templates, site/priority routing, rate limiting, event grouping, bounded retries with backoff, and delivery logs. Webhooks have a secret-based signature, event ID for deduplication, and an allowed endpoint. Notification failure neither blocks control nor clears alarms. External internet is unnecessary.

**FR-32 Reports.** CSV, PDF, daily/monthly summaries from local data: values/aggregates, operating time, transitions, alarms, and commands. Reports record interval, timezone, units, quality/gaps, template version, and generation time. Export runs as a resource-limited background job with local fonts/renderers. An unrestricted report designer is outside the first scope.

**FR-33 Backups and packages.** Scheduled and pre-update backups include results, integrity checks, and restoration into an isolated environment. Support local symbol, logic-block, device-profile, and driver packages with manifests and compatibility declarations. Provide LED/lighting, tank/pump, and thermostat/PID templates; adding them does not activate physical outputs.

## 10 Nonfunctional requirements

| ID | Requirement |
|---|---|
| NFR-01 | Closing the browser does not affect polling, logic, archives, or commands |
| NFR-02 | Install and operate from a prepared offline bundle with local documentation/packages |
| NFR-03 | Application services, builds, and tests run in Docker; the host needs Docker/Compose and required device drivers |
| NFR-04 | Modules have contract tests; core tests use virtual clocks and reproducible inputs |
| NFR-05 | No hard real-time claim; frequencies and latency bounds are measured on a specified bench |
| NFR-06 | Up to 100,000 signals is a scaling target, not an initial-demo capability |
| NFR-07 | Bounded queues, backpressure, script limits, and diagnosable quality degradation under overload |
| NFR-08 | Restore configuration, history, and secrets from backup on an isolated Docker bench |
| NFR-09 | Structured logs/metrics are locally accessible and exclude passwords/secrets |
| NFR-10 | Every milestone requirement maps to a test or reproducible acceptance procedure |

Deliverables and measurable criteria: [roadmap](roadmap.md), [TDD and acceptance](testing-and-acceptance.md).
