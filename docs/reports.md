# Daily and monthly signal reports

Status: M2 engineering increment. A bounded background job generates a fixed JSON summary and downloadable PDF/CSV for one boolean or float64 signal. Reports are read-only and never start devices or request outputs. Alarm/command reports, multi-signal templates, configured engineering units, local-calendar reporting, scheduled delivery and a free-form designer are not implemented.

## User workflow

Open a signal's History panel, select **Show reports**, choose Daily or Monthly and a UTC calendar date, then **Generate report**. The job moves through Queued, Generating and Ready, or Failed. Ready jobs offer **View report**, **Download PDF** and **Download report CSV**. Changing the form does not change an existing preview or downloaded snapshot. Jobs remain available after closing the browser; the latest 20 for the selected signal are listed.

Report boundaries are exact UTC days/months, with an exclusive end. Leap years are validated; impossible dates are rejected instead of normalized. Daily reports include all 24 hourly rows; monthly reports include every calendar day. Supported dates are 1900 through 2100. A current or future interval includes its entire calendar period and is provisional. Timezone selection and DST-local reporting remain separate work; the weekly control scheduler's named-zone rules do not silently change report boundaries.

## Data semantics

The worker reads signal metadata, completed hourly aggregates and pending recalculation jobs in one repeatable-read transaction. Aggregation delays are visible as pending coverage. Missing hours and stale aggregate hours contribute Unknown time, not zero-valued measurements. A pending job without a prior aggregate is also pending, rather than merely absent.

- Digital summaries show verified Good ON/OFF duration and sum the already-computed transition counts. No transition is invented between disconnected or missing hours.
- Analog means are weighted by Good duration, not number of samples or buckets. Extrema preserve the aggregate's valid observations. No usable duration yields a null mean; it does not yield zero.
- All five quality durations, missing/pending hour counts and invalid Good sample counts are retained. Malformed or overlapping aggregates fail the job instead of producing misleading totals.
- The current catalog does not expose configurable engineering units. Analog reports explicitly say units are not configured. Boolean durations are seconds. Do not infer units from a signal's name.
- Exact integer/counter report profiles are not supported by this first template and are rejected; no integer string is coerced into float64.

Each saved result includes report/signal IDs, signal name/type, UTC range, template version and generation time. Subsequent changes or recalculation of the archive do not alter that result. Regeneration makes a new job. This is an application-level snapshot, not a signed or certified record.

CSV contains a total row plus every period row, UTC bounds and quality durations. User-provided text is quoted and protected against spreadsheet formula interpretation. Negative numeric statistics remain numeric CSV cells. PDF uses escaped text in a fixed local HTML/CSS template, with bundled Chromium fonts. There are no online images, scripts or font requests. Glyph coverage depends on the bundled fonts; arbitrary-language font coverage is not certified.

## API and persistence

- `POST /api/v1/signals/:id/reports`: `{period:"day"|"month", date, requestKey:UUID}`; 202 for a new job and 200 for a matching repeated key.
- `GET /api/v1/signals/:id/reports`: generation configuration and latest 20 jobs.
- `GET /api/v1/reports/:id`: state and the Ready snapshot.
- `GET /api/v1/reports/:id/pdf` and `/csv`: authenticated attachments; unfinished jobs return 409.

All routes require a session and current project ownership; generation also requires origin/CSRF checks. Job ownership is checked again at generation and download. The request key is scoped to the requesting user; reusing it with changed parameters returns 409. Idempotency lasts while the retained job exists. Accepted requests are audited once in the insertion transaction. Capacity exhaustion returns 429.

Migration 011 adds the persistent queue and artifacts. The workspace permits at most 8 outstanding and 100 total jobs. Maintenance retains at most the latest 92 terminal jobs and removes terminal jobs older than 7 days, independently of historian retention. A job is limited to a 2 MiB PDF, 512 KiB CSV and 512 KiB JSON summary. Database backups include queued jobs and saved binary artifacts; restore preserves bytes. Download files that require longer retention.

## Runtime and isolation

The API starts a supervised private report worker with a 128 MiB Node heap when `APCS_REPORT_URL` is configured. It claims one queued job at a time with a PostgreSQL row lock, random lease token and 30-second lease. Publication requires the same token and an unexpired Generating state. Expired work becomes Failed (`Report generation interrupted`); late results are discarded. Renderer failures become Failed, with a bounded public error and no private exception/credential disclosure. The operator may submit a new request; control commands are never involved.

The private renderer uses the already-pinned Playwright 1.64.0 image and runs without published ports or database credentials, on an internal network, with a read-only filesystem, dropped capabilities, 1 CPU, 1 GiB RAM, 128 PIDs and a bounded temporary directory. Its template accepts at most 128 KiB and one request concurrently. JavaScript, service workers and page network requests are disabled; input is escaped text, not user-supplied HTML. The worker's HTTP call has a 15-second deadline and bounded response streaming. A 14-second renderer watchdog terminates stalled work, and a supervisor restarts the renderer after death. These are process/container boundaries; Chromium's own sandbox is disabled by the pinned Playwright launch defaults.

Both renderer and API source are bind-mounted with hot reload. Renderer process recovery is separate from source watching: `make renderer-recovery` kills the render child inside its test container and verifies a new healthy child appears without editing a file. This check runs before the complete `make test` suite. It must not be run concurrently with report browser/integration tests sharing that renderer.

The renderer's image and existing package versions are included in offline Compose overrides; no image rebuild is required for source changes. A newly generated full offline bundle is required to distribute this increment; an older bundle does not gain the feature automatically.

## Verified scope

Docker tests cover calendar boundaries and leap months, missing/pending coverage, weighted numeric means, digital duration, malformed aggregates, spreadsheet-safe CSV, queue capacity/idempotency, owner/CSRF enforcement, generation failure, lease fencing, retention and snapshot stability. A real private Chromium request generates PDF bytes and rejects excessive input. The browser creates and downloads a persisted report through the complete API/worker/renderer path; desktop, phone and print-template layouts are inspected. Backup/restore covers the new table and binary artifact bytes.

References: [MDN printing guidance](https://developer.mozilla.org/en-US/docs/Web/CSS/Guides/Media_queries/Printing) explains print styles and page layout; the renderer uses the [Playwright PDF API](https://playwright.dev/docs/api/class-page#page-pdf). Report quality and retention rules above are Open APCS contracts.
