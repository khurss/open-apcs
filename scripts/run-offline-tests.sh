#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
[ -f compose.offline-test.yml ] || { echo 'Run from an installed offline bundle.' >&2; exit 1; }
compose() { docker compose -f compose.test.yml -f compose.offline-test.yml "$@"; }
# Stop only this isolated test project; preserve dependency caches for later runs.
trap 'compose down --remove-orphans' EXIT INT TERM
compose run --rm --no-deps deps
compose run --rm firmware-test
compose run --rm firmware-build
compose run --rm all
compose run --rm offline-check
compose run --rm backup-test
compose up -d --force-recreate e2e-api
compose run --rm e2e
