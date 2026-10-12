#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
previous=''
while :; do
  current=$(find firmware/esp32-led -type f ! -name sdkconfig ! -name sdkconfig.old -print | sort | xargs sha256sum | sha256sum)
  if [ "$current" != "$previous" ]; then
    previous=$current
    make firmware-test firmware-build || printf 'Firmware check failed; waiting for the next source change.\n'
  fi
  sleep 2
done
