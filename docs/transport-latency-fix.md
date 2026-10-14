# LED transport latency investigation, 2026-10-14

Two transport defects were identified: small control packets waited behind Nagle/delayed TCP acknowledgements, and an already-resolved device reply made the handshake timer ineffective while the gateway still awaited the broker's PUBACK. These findings do **not** retrospectively prove the cause of the earlier uninstrumented extended-hour failure.

## Baseline and scope

The diagnostic ran 15 virtual LED outputs at 1 Hz, a physical ESP32 OFF renewal session, a read-only 100-block graph, the Chromium signal monitor and the archive. It deliberately submitted no physical output commands and did not reconcile the existing Unknown command. This is not the extended L0 profile: physical transitions and their alarm writes are absent.

Baseline `renewal-load-2026-10-14T08-48-31.237Z` was intentionally stopped through the commissioning API after 1419.001 measured seconds, following the discovery of TCP delays. It verified all 21,271 measured virtual commands, with no missed ticks or observed archive drops/errors. Its preserved result says `failed` / `Physical session stopped`: the requested hour was not completed and final history verification did not run. It must not be reported as a passed hour. The worker and independent supervisor stopped every target.

A complete gateway export allowed 2420 request/response pairs to be correlated with firmware receive/process/enqueue events. Non-cryptographic hashes, lengths, ordering and packet headers are correlation aids, not unique identities or independent electrical evidence.

| Baseline measure | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Gateway request to device reply, ms | 82.20 | 117.64 | 127.05 | 143.75 |
| Device receive callback to enqueue return, ms | 9.22 | 13.40 | 14.15 | 17.98 |
| Gateway publication to broker PUBACK callback, ms | 7.64 | 47.04 | 50.62 | 64.64 |

These pairings exclude firmware transport time before its receive callback and after enqueue return. They do not identify all remaining time as radio delay. The baseline used the previous instrumented firmware and revision `724b9c3`; private metadata preserves binary and fixture hashes. Four short isolated Docker unit-test executions also occurred during the diagnostic. No API source reload or board reset occurred during measurement.

## Packet evidence and corrections

At 09:11:28.909 UTC the gateway recorded a lease send. Its TCP socket first sent a 26-byte encrypted MQTT acknowledgement; the 254-byte lease segment appeared at 09:11:28.953564, immediately after the broker's pure TCP ACK at 09:11:28.953425. The broker's encrypted PUBACK followed at 09:11:28.953708. This identifies approximately 44 ms spent waiting before the lease reached the broker, rather than broker application processing.

On the board connection, a small encrypted MQTT acknowledgement arrived at 09:11:28.856109, the server's delayed TCP ACK followed at 09:11:28.897485, and the board's response arrived at 09:11:28.903566. The same pattern repeated for the lease response. The pinned MQTT.js and firmware configuration had not disabled Nagle on their client sockets; the broker already had `set_tcp_nodelay true`.

The gateway and simulator now set `TCP_NODELAY` on their TCP/TLS sockets before subscription. The firmware obtains its standard TLS transport at `MQTT_EVENT_BEFORE_CONNECT`, then sets `TCP_NODELAY` on the connected socket before subscribing. Failure to configure the firmware socket latches the transport fault and prevents arming. TLS authentication, QoS, expiry and replay rules remain unchanged. See [Node socket semantics](https://nodejs.org/api/net.html#socketsetnodelaynodelay) and the [pinned ESP-MQTT transport lifecycle](https://docs.espressif.com/projects/esp-idf/en/v5.5.1/esp32/api-reference/protocols/mqtt.html).

The passive collectors retained only TCP headers, lengths and timestamps, with no TLS/plaintext payloads. Initial Ethernet capture was ingress-only; the initial local-bridge captures contained no packets. Corrected `ETH_P_ALL` captures on the physical interface and broker veth verified both directions. Only those corrected captures support the bidirectional packet example above. Raw artifacts and private addresses remain local.

## Handshake deadline defect

Previously the timeout rejected only the device-reply promise. If that promise had already resolved, rejecting it had no effect on `Promise.all([publish, reply])`. A delayed PUBACK could therefore keep synchronization pending beyond 500 ms. Each exchange also started its own timer despite the protocol's total confirmation budget.

The timeout now races the complete exchange and both handshake stages share one monotonic 500 ms deadline. The 250 ms snapshot freshness check, 3000 ms device lease and command expiry remain unchanged. A late PUBACK or device reply does not revive authority or trigger another publication.

Five deterministic Docker regressions cover a timely device reply with a stalled PUBACK, a two-stage over-budget exchange, a missing reply, healthy completion without a stray timeout, and revocation of an established session during a stalled renewal. Three cases failed against the original implementation because synchronization was still pending after 501 ms. Six native socket checks additionally verify the TCP flag and invalid/closed-descriptor failures; the flag check failed before configuration was implemented.

## Verification status

Post-change `renewal-load-2026-10-14T09-25-43.054Z` completed 900.938 measured seconds after warm-up. All 13,500 virtual commands were Verified and all 13,500 changes were found in the archive, with zero missed ticks, archive drops/errors or physical handshake timeouts. The physical board stayed OFF with a stable boot. Both the worker and independent supervisor confirmed stopped runtimes afterward. This ad hoc diagnostic uses the existing load fixture's virtual outputs and observers; its source and firmware hashes are preserved privately. It is not a new public release gate.

| Post-change measure | p50 | p95 | p99 | Maximum |
| --- | ---: | ---: | ---: | ---: |
| Gateway request to device reply, ms | 42.09 | 50.25 | 58.48 | 124.27 |
| Device receive callback to enqueue return, ms | 9.05 | 13.31 | 14.38 | 18.39 |
| Gateway publication to broker PUBACK callback, ms | 1.80 | 7.40 | 12.89 | 28.19 |

All 1702 exported request/response pairs matched; the 12,576-event firmware capture had zero gaps, dropped events or unmatched stages. Maximum enqueue duration was 8.176 ms. The baseline's 16,636-event capture also had zero gaps, drops or unmatched stages. The approximately 57% reduction in p95 exchange time supports removing the observed transport delay, but the runs differ in duration and are not a controlled endurance qualification.

The complete post-change Ethernet capture contained seven repeated server-to-device TCP data segments, one before load; the local gateway/broker capture contained none. For two inspected repeats, the firmware had already recorded the MQTT PUBACK approximately 32-35 ms after enqueue, well before the TCP repeat at approximately 247-249 ms. Those examples are consistent with delayed TCP acknowledgement rather than failed first delivery. They do not establish radio loss or eliminate other network risks; no handshake failed in this capture.

`make test` exited 0 with 611 unit/integration tests in 74 files, all 13 Chromium scenarios, 448 native C checks, nine orchestration checks, ESP32 cross-compilation, renderer recovery, strict TypeScript, English validation, frontend/offline builds and backup/restore. The subsequently added established-session regression passed with the other four handshake cases; the corrected firmware transport lifecycle passed both diagnostic and normal cross-builds and the physical run above. All executable application checks used Docker with existing images and mounted source.

The normal diagnostic-disabled firmware was restored by writing only the application partition, with hash verification. A ten-second supervised OFF renewal check passed and both cleanup paths confirmed stopping. Restoring the virtual Climate PID demo exposed an Unknown heater command from its diagnostic shutdown. The existing virtual-only recovery API recorded a fresh simulator boot and Good OFF output, retained the original Unknown outcome and audited reconciliation; the prepared demo then ran normally. The physical command remains Unknown and unreconciled. No credentials, packet payloads or private board provisioning are included in the repository.

## Remaining boundaries

The original physical command remains Unknown and unreconciled. No alias device, direct database edit, bypass of the command interlock, or replay was used. Repeating the exact physical-output workload requires an explicitly audited physical recovery workflow, which the current application still lacks.

The previous 2588.876-second failure has no simultaneous device/network trace, so neither Nagle nor the separate promise defect can be named its proven sole cause. The pinned ESP-MQTT API also shares a mutex with network operations; calling enqueue from the control task remains a separate scheduling risk. No long enqueue stall was reproduced in this baseline. Full extended-hour qualification, actual radio/power fault injection and the documented electrical measurement limitations remain open.
