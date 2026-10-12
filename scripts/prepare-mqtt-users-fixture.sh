#!/bin/sh
set -eu
umask 077
base=/workspace/.cache/mqtt-tls-fixture
mosquitto_passwd -b -c "$base/passwords" gateway fixture-gateway-password
mosquitto_passwd -b "$base/passwords" device fixture-device-password
mosquitto_passwd -b "$base/passwords" health fixture-health-password
mosquitto_passwd -b "$base/passwords" e2e-gateway fixture-e2e-gateway-password
mosquitto_passwd -b "$base/passwords" e2e-device fixture-e2e-device-password
cat > "$base/acl" <<'CONFIG'
user gateway
topic write openapcs/led/v1/tls/led/in
topic read openapcs/led/v1/tls/led/out
user device
topic read openapcs/led/v1/tls/led/in
topic write openapcs/led/v1/tls/led/out
user e2e-gateway
topic write openapcs/led/v1/tls-e2e/led/in
topic read openapcs/led/v1/tls-e2e/led/out
user e2e-device
topic read openapcs/led/v1/tls-e2e/led/in
topic write openapcs/led/v1/tls-e2e/led/out
user health
topic write fixture/health
CONFIG
cat > "$base/mosquitto.conf" <<'CONFIG'
listener 8883
allow_anonymous false
cafile /fixtures/ca.crt
certfile /fixtures/server.crt
keyfile /fixtures/server.key
password_file /fixtures/passwords
acl_file /fixtures/acl
persistence false
log_dest stdout
CONFIG
printf 'Isolated MQTT test users and ACLs prepared.\n'
