# Backups and the offline engineering bundle

These tools cover the current Linux x86-64 engineering workspace. They do not constitute the complete future production/offline distribution: OS and Docker installers, additional firmware toolchains, plugin trust/update management, and additional architectures remain pending.

## PostgreSQL backup and recovery

Run `make backup` from the development repository. It creates a PostgreSQL custom-format dump and SHA-256 sidecar in `dist/backups`. Source databases remain running; `pg_dump` provides a consistent database snapshot. The archive includes projects, drafts, immutable revisions, authentication hashes, sessions, and command/audit history. It contains sensitive data and must be kept on controlled storage. Files use mode 0600. Copy both files to independent storage; a backup on the same SSD does not protect against disk loss.

Restore into a **new** database; existing databases are never overwritten:

```bash
docker compose run --rm backup sh scripts/database-restore.sh /backups/ARCHIVE.dump apcs_recovered
```

The checksum is verified before a database is created. Restore runs in one transaction with error-stop semantics and restores schema objects as well as data. A restore failure may leave a newly created empty database for inspection; the script does not drop databases. Recovery does not automatically change application connection settings or activate equipment. Inspect the restored state, revoke sessions if appropriate, and switch connection settings during a planned recovery. The current application rejects uncommissioned physical outputs by default. Future runtime activation must retain a separate explicit rearming/fencing boundary; restoring command history must never replay old commands.

The automated Docker recovery check creates temporary fixture databases and verifies project/document contents, revision immutability triggers, archive permissions, overwrite refusal, and corruption rejection. It deletes only its own fixture databases. `make backup-test` runs it separately; `make test` includes it. Filesystem/device configuration outside PostgreSQL is not part of the database dump.

## Creating an offline bundle

Prepare the tool image and dependency cache, run the complete Docker suite, and stage the reviewed source snapshot. Then run:

```bash
make offline-bundle
```

The builder exports the Git index tree rather than an arbitrary directory copy. Tracked changes must be staged; ignored files, Git credentials, database volumes, `old-code`, and untracked private files are not included. The tree hash identifies the exact source snapshot even before it is committed. A bundle is written once to `dist/bundles/open-apcs-TREEHASH`; an existing bundle directory is not overwritten. A `.incomplete` marker prevents use of interrupted builds.

The bundle contains:

- Source archive and the frozen pnpm lockfile.
- The prepared pnpm content-addressed store for the current platform.
- Local Docker archives for the Node/pnpm tool image, PostgreSQL, Mosquitto, Chromium/Playwright, and the pinned ESP-IDF firmware toolchain.
- Compose overrides with local image tags and no image pulls for the distribution services.
- An installer, source-tree/platform manifest, and SHA-256 checksums.

No source changes require rebuilding the Node tooling image. Bundle preparation saves images already present locally. The builder fails if required images are missing. Checksums detect accidental corruption; they are not a signature or a substitute for trusted distribution media. The project's open-source license remains undecided, so this artifact is explicitly an engineering preview.

## Installing and running without internet

The target needs Linux x86-64, an installed Docker Engine, and Docker Compose supporting `!override`. Docker/OS installation is outside this bundle. Copy the entire bundle directory and run:

```bash
sh install.sh /absolute/path/to/a/new/open-apcs
cd /absolute/path/to/a/new/open-apcs
docker compose -f compose.yml -f compose.offline.yml up -d api web
```

The installer verifies checksums, imports local images, extracts sources into a new workspace, and installs locked dependencies with `pnpm --offline`. Its dependency service uses an internal Docker network without internet access. It never overwrites an existing workspace. Initial administrator creation follows [API startup](api.md), using both Compose files in every command. There is no default account.

The default UI is http://localhost:5173 and the direct API is http://localhost:3100. To coexist with another workspace, prefix startup commands with `WEB_PORT=15173 API_PORT=13100`; the override sets the matching authentication Origin. These environment values must also accompany later recreations, or be written to the local `.env`. Development and offline deployments use distinct Compose project names and database volumes. The loopback-only engineering profile is not a production LAN/TLS configuration.

Run the entire test suite from the installed workspace:

```bash
sh scripts/run-offline-tests.sh
```

This creates a separate offline test project, installs from the bundled cache, runs sanitized native firmware tests and cross-compilation, TypeScript and unit/integration tests, builds the web client, verifies offline dependencies and backup/restore, and executes Chromium scenarios. Its application-test network is internal. The script stops only that test project on exit; dependency caches are preserved.

`make offline-check` performs an additional smaller check in the normal repository: a container with **network_mode: none**, a copied source tree without installed modules, and a fresh anonymous pnpm-store volume installs from the prepared archive, typechecks, and builds the frontend. It runs as part of `make test`. The separate clean-workspace distribution drill verifies the exported bundle/installer and the complete suite; this does not prove installation on every possible offline host.

## Remaining distribution work

Production certificates and broker ACL provisioning, signed update/package policy, unattended backup scheduling/retention, encrypted remote backup destinations, additional firmware SDK caches and guided USB/OTA workflows, ARM64, and hardware verification remain on the roadmap. The current backup/offline tools do not mark these requirements complete.

## Verified firmware bundle drill

On 2026-10-12, source tree `81a06719c123` (the functional firmware snapshot committed as `638468f`) was exported to a 5.1 GiB local bundle, installed into a new workspace with fresh Compose dependency volumes, and passed 311 TypeScript unit/integration tests, five Chromium scenarios, 227 native C assertions, ESP32 cross-compilation, typechecking, frontend/offline builds and database backup/restore. Image import reused the same Docker host; this was not a second-machine or hardware test. The fixed snapshot predates TLS bench commissioning. New bundle scripts also include generation of isolated TLS test fixtures from the bundled tool images; do not attribute those newer tests to this older drill.

## Verified reporting and TLS bundle drill

On 2026-10-12, source tree `44661843d5d7b0281209e2e21fbbff06780550d5` from commit `b4e1149` was exported to `dist/bundles/open-apcs-44661843d5d7` (5.1 GiB) and installed into a new workspace, `/tmp/open-apcs-drill-44661843d5d7`. All installer checksums passed; Docker imported the five local images, and frozen pnpm installation reused all 209 package archives with zero downloads. Unique `apcs-drill-44661843d5d7-install` and `apcs-drill-44661843d5d7-test` project names ensured fresh dependency volumes without changing existing development/offline volumes.

The installed snapshot passed **516 unit/integration tests, 5 Chromium scenarios, 378 native C assertions, a clean ESP32 cross-compilation, renderer child recovery, TypeScript, English checks, web/offline builds and database backup/restore**. Tests used internal Docker networks; the separate dependency-copy/build check and firmware services used no network. The complete run exited successfully and stopped only its isolated test services. The installation remains available, with nonconflicting UI/API port values 15173/13100 in its local `.env`; it is not started automatically. Use the unique installation project name explicitly if starting this retained drill workspace.

This drill ran on the same Debian x86-64 Docker host and reused its image store. It is not a second-machine, physical-controller or production-distribution acceptance result. The fixed bundle includes TLS commissioning, reports and expiring LED command retention; it predates timed sequences and active graph diagnostics. Later source changes pass their own networkless install/build gates and must not be attributed to this fixed archive. The license remains undecided and the existing distribution limitations still apply.
