#!/bin/sh
set -eu
# This service has network_mode:none and a fresh anonymous store volume.
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT INT TERM
tar --exclude=node_modules --exclude=.git --exclude=dist --exclude=coverage --exclude=test-results --exclude=playwright-report --exclude='.env*' -cf - . | tar -xf - -C "$scratch"
mkdir -p "$scratch/dist"
tar -C /cache -cf "$scratch/dist/pnpm-store.tar" store
cd "$scratch"
sh scripts/install-offline-deps.sh
pnpm typecheck
pnpm --filter @open-apcs/web build
printf 'Offline dependency check passed with no network and fresh modules/store.\n'
