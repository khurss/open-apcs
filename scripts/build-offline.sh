#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
# The index defines the export; staging is reversible and does not create a commit.
git diff --quiet || { echo 'Stage the reviewed source snapshot before bundling.' >&2; exit 1; }
tree=$(git write-tree)
short=$(printf '%s' "$tree" | cut -c1-12)
git cat-file -e "$tree:scripts/install-offline.sh"
output="dist/bundles/open-apcs-$short"
[ ! -e "$output" ] || { echo 'This bundle directory already exists.' >&2; exit 1; }
images=$(docker compose -f compose.test.yml --profile firmware config --images | sort -u)
node_image=${DEV_IMAGE:-open-apcs-dev:node24-pnpm10}
postgres_image=$(printf '%s\n' "$images" | grep '^postgres:')
mqtt_image=$(printf '%s\n' "$images" | grep '^eclipse-mosquitto:')
browser_image=$(printf '%s\n' "$images" | grep '^mcr.microsoft.com/playwright:')
firmware_image=$(printf '%s\n' "$images" | grep '^espressif/idf:')
for image in "$firmware_image" "$node_image" "$postgres_image" "$mqtt_image" "$browser_image"; do docker image inspect "$image" >/dev/null; done
mkdir -p "$output"
touch "$output/.incomplete"
node_tag="open-apcs-bundle/node:$short"
postgres_tag="open-apcs-bundle/postgres:$short"
mqtt_tag="open-apcs-bundle/mqtt:$short"
browser_tag="open-apcs-bundle/browser:$short"
firmware_tag="open-apcs-bundle/firmware:$short"
docker tag "$node_image" "$node_tag"
docker tag "$postgres_image" "$postgres_tag"
docker tag "$mqtt_image" "$mqtt_tag"
docker tag "$browser_image" "$browser_tag"
docker tag "$firmware_image" "$firmware_tag"
git archive --format=tar "$tree" > "$output/source.tar"
docker compose -f compose.test.yml run --rm unit tar -C /pnpm -cf "/workspace/$output/pnpm-store.tar" store
docker image save -o "$output/images.tar" "$node_tag" "$postgres_tag" "$mqtt_tag" "$browser_tag" "$firmware_tag"
cp scripts/install-offline.sh "$output/install.sh"
cat > "$output/compose.offline.yml" <<CONFIG
name: open-apcs-offline
services:
  script-runner:
    image: $node_tag
    pull_policy: never
  deps:
    image: $node_tag
    pull_policy: never
    networks: !override [development]
    command: [sh, scripts/install-offline-deps.sh]
  api:
    image: $node_tag
    pull_policy: never
    environment:
      APCS_ORIGIN: http://localhost:\${WEB_PORT:-5173}
  web:
    image: $node_tag
    pull_policy: never
    ports: !override ["127.0.0.1:\${WEB_PORT:-5173}:5173"]
  postgres:
    image: $postgres_tag
    pull_policy: never
  simulation-mqtt:
    image: $mqtt_tag
    pull_policy: never
  backup:
    image: $postgres_tag
    pull_policy: never
CONFIG
cat > "$output/compose.offline-test.yml" <<CONFIG
name: open-apcs-offline-test
services:
  script-runner:
    image: $node_tag
    pull_policy: never
  deps:
    image: $node_tag
    pull_policy: never
    networks: !override [test]
    command: [sh, scripts/install-offline-deps.sh]
  postgres:
    image: $postgres_tag
    pull_policy: never
  mqtt:
    image: $mqtt_tag
    pull_policy: never
  e2e:
    image: $browser_tag
    pull_policy: never
  mqtt-tls-cert:
    image: $firmware_tag
    pull_policy: never
  mqtt-tls-users:
    image: $mqtt_tag
    pull_policy: never
  mqtt-tls:
    image: $mqtt_tag
    pull_policy: never
  firmware-test:
    image: $firmware_tag
    pull_policy: never
  firmware-build:
    image: $firmware_tag
    pull_policy: never
  backup-test:
    image: $postgres_tag
    pull_policy: never
CONFIG
printf '%s\n' "$node_tag" > "$output/node-image.txt"
printf '{"schemaVersion":1,"sourceTree":"%s","architecture":"linux/amd64","scope":"engineering-preview"}\n' "$tree" > "$output/manifest.json"
cat > "$output/README.txt" <<'README'
Open APCS offline engineering preview (Linux x86-64).
Requires an already installed Docker Engine and Docker Compose supporting !override/!reset.
Run: sh install.sh /absolute/path/to/a/new/workspace
Then follow the startup and local administrator instructions printed by the installer.
The bundle contains the Git index snapshot, locked package cache, and five container images including the pinned ESP32 toolchain.
It does not contain databases, secrets, old-code, an OS/Docker installer, or hardware acceptance evidence.
Checksums detect accidental corruption; authenticate the source/media separately.
The project license is undecided. This is a local engineering bundle, not a licensed release.
README
(cd "$output" && sha256sum source.tar pnpm-store.tar images.tar install.sh compose.offline.yml compose.offline-test.yml node-image.txt manifest.json README.txt > SHA256SUMS)
rm "$output/.incomplete"
printf 'Offline bundle ready: %s\n' "$output"
