.PHONY: image bootstrap install watch watch-bg watch-integration test unit integration typecheck shell stop config

# All executable application checks run inside Docker. Source changes are bind
# mounted; image is rebuilt only when Node/pnpm or the Dockerfile changes.
image:
	docker compose -f compose.test.yml build unit

bootstrap:
	docker compose -f compose.test.yml run --rm deps sh scripts/install-deps.sh --create-lockfile

install:
	docker compose -f compose.test.yml run --rm deps

watch:
	docker compose -f compose.test.yml up unit-watch

watch-bg:
	docker compose -f compose.test.yml up -d unit-watch

watch-integration:
	docker compose -f compose.test.yml up integration-watch

test: firmware-test firmware-build
	docker compose -f compose.test.yml run --rm all
	docker compose -f compose.test.yml run --rm offline-check
	docker compose -f compose.test.yml run --rm backup-test
	$(MAKE) e2e

unit:
	docker compose -f compose.test.yml run --rm unit

integration:
	docker compose -f compose.test.yml run --rm integration

typecheck:
	docker compose -f compose.test.yml run --rm typecheck

shell:
	docker compose -f compose.test.yml run --rm toolbox sh

stop:
	docker compose -f compose.test.yml down --remove-orphans

config:
	docker compose -f compose.yml config --quiet
	docker compose -f compose.test.yml config --quiet

.PHONY: install-dev dev dev-stop
install-dev:
	docker compose run --rm deps

dev:
	docker compose up -d api web

dev-stop:
	docker compose down --remove-orphans

.PHONY: e2e
e2e:
	docker compose -f compose.test.yml up -d --force-recreate e2e-api
	docker compose -f compose.test.yml run --rm e2e

.PHONY: backup backup-test
backup:
	mkdir -p dist/backups
	docker compose run --rm backup

backup-test:
	docker compose -f compose.test.yml run --rm backup-test

.PHONY: offline-check offline-bundle
offline-check:
	docker compose -f compose.test.yml run --rm offline-check

offline-bundle:
	sh scripts/build-offline.sh

.PHONY: firmware-test firmware-build firmware-watch
firmware-test:
	docker compose -f compose.test.yml run --rm firmware-test

firmware-build:
	docker compose -f compose.test.yml run --rm firmware-build

firmware-watch:
	sh scripts/watch-firmware.sh
