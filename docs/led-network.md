# LED network increment

This M0 increment implements a versioned LED protocol, MQTT gateway/simulator, and a headless scheduling library. It is a development path verified with PostgreSQL and Mosquitto, not ESP32 firmware or the finished application. The protocol is intentionally limited to one boolean output per configured device; other device profiles remain on the roadmap.

## Frames and trust

Topics are `openapcs/led/v1/{siteId}/{deviceId}/in` and `/out`. Identifiers contain only ASCII letters, digits, underscores, and hyphens, up to 128 characters. Frames are UTF-8 JSON, at most 4096 bytes, with `v: 1` and an exact field set. Unknown fields, invalid types, unsupported versions, malformed UTF-8, and retained frames are rejected.

| Frame | Direction | Purpose |
|---|---|---|
| `probe` | Gateway → device | Fresh random nonce requesting a clock/state snapshot |
| `snapshot` | Device → gateway | Echo nonce, boot ID, monotonic device time, sequence, output value |
| `lease` | Gateway → device | Nonce, boot ID, control session ID, device-clock deadline |
| `ready` | Device → gateway | Confirm the accepted lease and return current state |
| `write` | Gateway → device | Command ID, boot/control session, device-clock deadline, boolean value |
| `ack` | Device → gateway | Applied output value or explicit failure reason |
| `telemetry` | Device → gateway | Sequenced current output, device time, boot/session |

The gateway accepts a device only through its preconfigured topic and a correlated handshake. A nonce prevents replay of old replies; it does not authenticate a malicious publisher that can access the same topics. Real deployments require individual credentials, broker ACLs, and appropriate TLS. Connection options accept credentials/certificates, but an authenticated deployment and adversarial broker-ACL tests remain work for the application/deployment phase. Anonymous MQTT is confined to the existing isolated test fixture.

The initial adapter explicitly uses MQTT 5 with clean sessions, no automatic reconnect, and Retain As Published subscriptions. This allows rejection of a retained write even when forwarded to an existing subscriber. Publications use QoS 1, `retain=false`, and one-second message expiry; application deadlines and deduplication remain mandatory. See [MQTT.js](https://github.com/mqttjs/MQTT.js) and the [MQTT 5 specification](https://docs.oasis-open.org/mqtt/mqtt/v5.0/os/mqtt-v5.0-os.html). MQTT 3.1.1 remains a separate compatibility task.

## Time and output authority

Gateway and device clocks may have unrelated origins. A snapshot must return within 250 ms; the complete handshake must finish within 500 ms. A lease ends no later than 3000 ms after the device's snapshot. The gateway uses an earlier local deadline, and sends commands only after the device confirms the lease. A previous setup frame cannot extend an accepted lease.

Command deadlines are conservatively mapped from gateway monotonic time to the device's clock using the snapshot receipt time, a 1000 ppm relative-rate allowance, and a 10 ms margin. Clock samples older than 1500 ms cannot issue writes. This assumes monotonic clocks with relative rate error at most 1000 ppm over the bounded interval; it is not a measured ESP32 timing guarantee. Hardware verification must establish that bound or replace this mapping with a verified clock/freshness mechanism.

The journal now returns `deadlineMonotonicMs`, anchored to database time before COMMIT. COMMIT latency therefore consumes the remaining deadline. This field is valid only in the same process using `performance.now()`; it must not be serialized to a different process or host. The existing database wall-clock limitations still apply between journal operations.

OFF is the LED demo's configured failure state. Lease renewal preserves the current output only while its lease is live. After expiration, a new handshake does not restore ON. Boot/session mismatches and expired writes fail; repeated command IDs do not repeat physical intent. Both peers retain at most 128 still-valid command identities and discard records only after the original deadline, without changing the output. The simulator watchdog is still driven by clock observations. See [retention semantics and identity assumptions](led-command-retention.md).

## Gateway, journal, and scheduling

The gateway checks live ownership, interlocks, project revision, quality, and boot session when claiming and again before publication. Claims are scoped to the configured output so one gateway cannot consume another device's work. Once consumed, an intent is never automatically reissued. Device ACK is persisted in the journal; telemetry alone never verifies a command whose ACK was lost.

Gateway shutdown immediately invalidates its session and disconnects signal quality; pending commands become Cancelled and dispatched outcomes become Unknown. Reconnect requires a fresh handshake. Once a boot has established a lease, any changed boot in a later snapshot is rejected before another lease is sent. This restriction survives repeated synchronization attempts and is cleared only by an explicit gateway start. The runtime faults and requires an explicit operator restart; old queued commands are cancelled. Receive work is bounded to 128 queued frames; overflow closes the connection. Publication waits are bounded to one second. Connection and parsing diagnostics exclude message payloads and credentials.

`LedRuntime` polls every 50 ms after the prior cycle finishes and renews the session approximately every second. It does not overlap cycles or replay missed cycles in a burst. Recovery runs through the journal. Journal/transport failures stop the worker and lease renewal; restarting is explicit. Device telemetry alone cannot renew the lease. This is a single-device development worker, not the later partitioned 10,000-device scheduler.

## Verification and remaining work

Container tests cover independent clock origins, stale setup, retained/malformed packets, deadline mapping, duplicate writes, lease expiry, boot changes, reconnect, lost ACK, interlock revalidation, per-output claim isolation, and startup/stop races. Real PostgreSQL/Mosquitto integration is combined with deterministic unit clocks. Separate physical GPIO18 pulse, lease-expiry, broker-pause and USB-reset evidence is recorded in [the Rigol fixture](rigol-hil.md); container tests alone do not establish physical acceptance.

Later increments added the authenticated application, catalog, private runtime, editors, explicit Unknown reconciliation, and offline engineering distribution. A compiled C LED endpoint now shares this wire contract; see [firmware scope](firmware.md). Initial physical commissioning, a dedicated TLS broker with topic ACLs and bounded instrumented fault checks are available for the LED bench. Broader HIL acceptance and the remaining M1–M5 requirements are still pending. See the [current roadmap](roadmap.md) for milestone status.
