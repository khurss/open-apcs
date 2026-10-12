#!/bin/sh
set -eu
archive=${1:-dist/pnpm-store.tar}
[ -f "$archive" ] || { echo 'Prepared pnpm store archive is missing' >&2; exit 1; }
[ -f pnpm-lock.yaml ] || { echo 'A frozen lockfile is required' >&2; exit 1; }
tar -xf "$archive" -C /pnpm
CI=true pnpm install --offline --frozen-lockfile
