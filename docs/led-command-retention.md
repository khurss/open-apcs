# LED command identity retention

Status: engineering behavior shared by the ESP32 C core and TypeScript simulator. This replaces the earlier total-per-boot cache limit without increasing firmware memory or changing the v1 wire format.

## Bounded validity window

Both peers retain up to **128 still-valid applied commands**. A record contains the command ID, original deadline and payload fingerprint. An identical retry while valid returns the original acknowledgement without changing the output. A conflicting ID still present in the cache fails. If all slots are occupied by unexpired entries, a new command fails; no live entry is evicted to make room.

Entries are removed only when monotonic device time reaches their original command deadline. An unchanged old frame is then ineligible for execution because the receive path rejects an expired deadline before applying any output. Invalid boot/session, absent lease and deadlines beyond the current lease are also rejected. Firmware latches a reversed/invalid device-clock fault; the simulator coordinator supplies the monotonic clock.

Expiration of a cache entry **does not change the output**. Command deadlines limit when an intent may be applied. The independent control lease governs how long authority can hold the resulting state; lease expiration still forces the configured LED fallback OFF. Renewing a live lease does not renew old command deadlines or restore old command records.

The firmware's existing bounded array is compacted during `apcs_tick`; the simulator removes expired map entries when observing its clock. The maximum live cache size is 128 in both. Normal 1 Hz control can continue for more than 128 commands per boot while its leases remain valid; the 128-slot limit is a burst bound, not a lifetime counter.

## Identity and trust boundary

The gateway's durable command journal allocates immutable command identities and rejects conflicting request reuse. It must never reuse a prior command ID with a new deadline or different intent. The device's conflict lookup covers its retained validity window; it is not an unlimited lifetime registry of UUIDs. After expiration the device cannot recognize an ID maliciously repackaged with a future deadline. Such a frame is a changed request, not replay of the original bytes, and must be excluded by the authenticated gateway/journal. TLS credentials, broker ACLs and one active control owner remain part of the bench contract. New adapters must preserve immutable identity and expiry semantics.

Transport duplicates and delayed delivery keep the original deadline. A lease renewal, reconnect or application retry must not rewrite an old command deadline. Uncertain dispatched commands remain Unknown in the journal and are not resent automatically. This change does not add automatic physical reconnection, change watchdog fallback, or remove the need for independent hardware protections.

## Evidence and limits

Docker TDD includes live-cache saturation, partial expiration, output hold during cleanup, duplicate acknowledgement after a later OFF, conflicting live IDs and rejection at the exact expiry boundary. The simulator also now rejects deadlines extending beyond its lease, matching the C core.

A C virtual-clock test runs 3,600 writes with renewed leases over one simulated hour. A TypeScript test runs 12,000 writes over simulated time. The compiled C JSON harness and TypeScript network peer compare 300 successive commands and a delayed original frame byte-for-byte at the decoded contract level. These are deterministic state-machine/wire tests, not a real-time soak, MQTT throughput measurement or physical HIL result. L0 and physical acceptance remain pending.
