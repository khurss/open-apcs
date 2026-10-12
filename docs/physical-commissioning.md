# ESP32 LED bench commissioning

Status: the server, browser, TLS broker and protocol simulator path is implemented. ESP32 firmware is cross-compiled and its C protocol core is tested natively. No physical GPIO, radio, watchdog reset or clock-drift acceptance is claimed. The owner will connect the board later. This profile is limited to an isolated LED with a current-limiting resistor; it is not a general actuator or safety controller.

## Explicit configuration

Physical connections are disabled by default. An administrator supplies a private regular JSON file (mode 0600, at most 32 KiB). The private runtime worker reads it at startup; changes require an API/worker restart and explicit rearming. The configuration is not sent to the browser or recorded in the audit data.

```json
{
  "url": "mqtts://broker.example.lan:8883",
  "username": "gateway-led-bench",
  "password": "replace-with-a-private-generated-secret",
  "ca": "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n",
  "devices": [{ "siteId": "bench", "deviceId": "esp32-1", "gpio": 18 }]
}
```

The TLS URL must not contain credentials. A valid CA certificate is required; certificate/hostname verification cannot be disabled by this configuration. The initial allowlist accepts at most 16 addresses and GPIO 18, 19, 21, 22, 23, 25, 26, 27, 32 or 33. The catalog site/address, firmware provisioning and reviewed pin must match this allowlist. The server checks the configured pin; it does not remotely measure the wiring or read back the firmware's NVS pin selection.

Store the file outside the repository, owned by the container's UID 1000. Add a local Compose override, using your own absolute path:

```yaml
services:
  api:
    environment:
      APCS_PHYSICAL_CONFIG: /run/secrets/physical.json
    volumes:
      - /absolute/private/physical.json:/run/secrets/physical.json:ro
```

Start with `docker compose -f compose.yml -f /absolute/private/compose.bench.yml up -d api web`. The broker must be reachable from the API container. The existing internal `simulation-mqtt` broker is exclusively for simulation and must not be exposed as a physical broker. Production broker installation, certificate issuance and rotation remain administrator responsibilities; no default physical password or public listener is supplied.

Give each device a distinct broker account: read its exact `openapcs/led/v1/SITE/DEVICE/in` topic and write its corresponding `out` topic. The gateway account needs the inverse rights for its configured devices. Disable anonymous access. Do not grant wildcard writes to devices. The fixed fixture accounts under `.cache/mqtt-tls-fixture` are exclusively for isolated Docker tests and must never be used for deployment.

## Operator workflow

1. Provision the firmware as described in [firmware.md](firmware.md); independently check the wiring, supply and current-limiting resistor.
2. Add an ESP32 LED catalog profile with the configured site/address.
3. In its device card, select the reviewed GPIO, enter a reason and acknowledge the isolated LED connection. Select **Arm LED bench**.
4. The server cancels accepted old intents and marks dispatched unresolved work Unknown before opening a new control session. Initial arming requires a Good OFF observation. `Hardware bench running` reports the selected transport/profile; it is not hardware acceptance evidence.
5. Use Signals or a prepared HMI for the normal reasoned, durable command path. A `Verified` acknowledgement means the firmware reported its GPIO operation, not an independent measurement of an actuator position.
6. Select **Disarm LED bench** with a reason to revoke renewal and disconnect signal quality. The device lease expires within at most three seconds under the specified clock assumptions. `Stopped` is not an immediate verified OFF reading; independent protections remain necessary.

A worker/API restart, source hot reload or ownership loss never automatically restores control. Explicit arming is required again. Firmware transport loss additionally requires its documented restart procedure. Unresolved physical Unknown commands remain blocked; the virtual-device reconciliation endpoint cannot clear them. Guided physical reconciliation is still pending.

Prepared graphs may use explicitly armed bench outputs through the same journal and ownership rules. Stopping a graph revokes its outputs. This path has protocol-simulator coverage; physical graph timing is unverified.

## API and evidence

`POST /api/v1/devices/:id/commission` requires a session, same Origin, CSRF token and project ownership. Start body: `{ "action": "start", "gpio": 18, "acknowledgeLedOnly": true, "reason": "Reviewed LED bench" }`. Stop body: `{ "action": "stop", "reason": "End bench" }`. Unknown fields are rejected. Concurrent commissioning requests for a device return 409. The existing virtual runtime mutation route continues to reject physical profiles.

Requested/completed actions are audited without credentials. Completion audit failure revokes authority; a failed stop audit still attempts to stop. The server returns a generic failure and does not echo broker secrets. Private-worker and browser tests use an actual isolated TLS Mosquitto broker and a protocol simulator, including ACL denial, wrong credentials, untrusted certificates, old-intent cancellation, worker loss and audit failure.
