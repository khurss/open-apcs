#!/bin/sh
set -eu

if [ "${1:-}" = "--create-lockfile" ]; then
  if [ -f pnpm-lock.yaml ]; then
    echo 'pnpm-lock.yaml already exists; use the frozen installation.' >&2
    exit 2
  fi
  exec pnpm install --no-frozen-lockfile
fi

if [ ! -f pnpm-lock.yaml ]; then
  echo 'No lockfile yet. Run the Docker deps service with --create-lockfile once.' >&2
  exit 2
fi

exec pnpm install --frozen-lockfile
