#!/bin/sh
set -eu
bundle=$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)
[ "$#" -eq 1 ] && [ ! -e "$1" ] || { echo 'Usage: install.sh NEW_WORKSPACE_DIRECTORY (must not exist)' >&2; exit 2; }
[ ! -e "$bundle/.incomplete" ] || { echo 'Incomplete bundle' >&2; exit 1; }
(cd "$bundle" && sha256sum -c SHA256SUMS)
case "$(docker info --format '{{.OSType}}/{{.Architecture}}')" in linux/x86_64|linux/amd64) ;; *) echo 'This bundle requires Linux x86-64 Docker' >&2; exit 1;; esac
# Image import uses only the verified local archive.
docker image load -i "$bundle/images.tar"
mkdir -p "$1"
target=$(CDPATH='' cd -- "$1" && pwd)
tar -xf "$bundle/source.tar" -C "$target"
cp "$bundle/compose.offline.yml" "$bundle/compose.offline-test.yml" "$target/"
mkdir -p "$target/dist"
cp "$bundle/pnpm-store.tar" "$target/dist/pnpm-store.tar"
node_image=$(cat "$bundle/node-image.txt")
printf 'DEV_IMAGE=%s\n' "$node_image" > "$target/.env"
cd "$target"
docker compose -f compose.yml -f compose.offline.yml run --rm --no-deps deps
printf '\nInstalled locally into %s\n' "$target"
printf '%s\n' 'Start: docker compose -f compose.yml -f compose.offline.yml up -d api web' 'Bootstrap the administrator using docs/api.md, adding -f compose.offline.yml to the compose command.' 'Run the offline test suite: sh scripts/run-offline-tests.sh' 'See docs/distribution.md for ports, backup, restore, and scope limitations.'
