#!/bin/sh
set -eu
umask 077
base=/workspace/.cache/mqtt-tls-fixture
mkdir -p "$base"
if [ -f "$base/server.crt" ] && openssl x509 -checkend 3600 -noout -in "$base/server.crt" >/dev/null; then exit 0; fi
openssl req -x509 -newkey rsa:2048 -nodes -keyout "$base/ca.key" -out "$base/ca.crt" -days 365 -subj '/CN=Open APCS test CA' >/dev/null 2>&1
openssl req -newkey rsa:2048 -nodes -keyout "$base/server.key" -out "$base/server.csr" -subj '/CN=mqtt-tls' >/dev/null 2>&1
cat > "$base/server.ext" <<'CONFIG'
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:mqtt-tls,DNS:localhost,IP:127.0.0.1
CONFIG
openssl x509 -req -in "$base/server.csr" -CA "$base/ca.crt" -CAkey "$base/ca.key" -CAcreateserial -out "$base/server.crt" -days 365 -extfile "$base/server.ext" >/dev/null 2>&1
printf 'Isolated MQTT test certificates prepared.\n'
