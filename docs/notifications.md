# Alarm notification delivery

Status: implemented engineering profile within partial M2. Alarm transactions enqueue durable deliveries; a private background process sends SMTP/webhooks and the Alarms page shows delivery and attempt logs. No actual recipient is configured in the development workspace. Hardware acceptance and the remaining M2 features are still pending.

## Destination contract

The private configuration file contains version 1 and up to 16 routes. Each route has an immutable `id`, a display `name`, `kind` (`smtp` or `webhook`), nonempty `priorities` and `events` lists, and `projectIds` (empty means all projects on this single-operator workspace). Supported events are Activated, Reactivated, Returned and Unsuppressed. State-based routing must suppress delivery while an alarm is suppressed; Unsuppressed is deliverable only for an active, unacknowledged condition. A notification never acknowledges or clears an alarm.

Webhook routes specify an HTTP(S) `url` and a signing `secret` of 32–512 characters. SMTP routes specify `host`, `port`, `security` (`tls`, `starttls` or `none`), one plain ASCII `from` and `to` address, and optional username/password authentication. Optional CA certificates support an isolated local PKI; SMTP additionally permits an explicit TLS server name for a configured IP endpoint. TLS verifies certificates and hostnames. Plain HTTP or SMTP requires explicit `allowInsecure: true`. URL credentials, fragments, arbitrary headers and unrecognized fields are rejected.

Only route identity, label, kind and routing filters may appear in the public API. Endpoint URLs, signing keys, credentials and CA contents remain in private configuration. A canonical SHA-256 fingerprint binds queued work to its exact configuration; changing a destination must not silently send old queued events to a different recipient.

## Transport behavior

The transport accepts at most 8 KiB of JSON with an event identity matching its envelope. Delivery and event identities are bounded and cannot inject headers. Webhooks send the exact body with `X-APCS-Event-ID`, `X-APCS-Delivery-ID`, `X-APCS-Timestamp` (Unix seconds) and `X-APCS-Signature`. The signature is `sha256=HEX(HMAC-SHA256(secret, timestamp + "." + body))`. A receiver should verify the signature and clock tolerance and deduplicate the stable event identity. No redirect is followed. Responses are accepted only for 2xx; 408, 429, 5xx and transport failures are retryable by the durable dispatcher, not inside the transport.

SMTP sends a static plain-text template containing the event JSON as base64 MIME content, with a stable Message-ID derived from the delivery ID. It supports implicit TLS, required STARTTLS and explicitly permitted plaintext. There are no user-supplied MIME headers, attachments, local file paths, remote content fetches or HTML templates. Acceptance means that the SMTP endpoint accepted the message, not that a human received or read it.

Each attempt has a five-second total deadline and optional cancellation. HTTP requests and SMTP connections close on completion, failure, timeout or cancellation. Error messages exposed by the transport contain no endpoint response body or credentials. Payload validation precedes networking. Local integration tests cover signed HTTPS, untrusted certificates, redirects, retry classification, deadlines/cancellation, authenticated TLS SMTP and bad credentials. They use only Docker-local test listeners and fixture addresses.

The implementation uses pinned Nodemailer 10.1.0 SMTPConnection and smtp-server 3.19.21 only for test listeners. See the official [SMTPConnection API](https://nodemailer.com/extras/smtp-connection) and [SMTP test server API](https://nodemailer.com/extras/smtp-server). Payload construction and all retry/ownership policies are Open APCS responsibilities. The project license remains undecided.

## Durable dispatch

Alarm events, state, audit and notification insertion share one PostgreSQL transaction. Each matching route receives one immutable JSON payload with stable `alarmId:eventVersion` identity and a UUID delivery ID. Suppressed transitions do not enqueue work. Unsuppressed events enqueue only while active and unacknowledged. Previously queued events remain deliverable after suppression or acknowledgement; they describe historical occurrences and include their timestamp. Delivery never changes alarm state or output authority.

Public metadata is synchronized from private configuration. Pending and Sending deliveries carry a configuration fingerprint. Changed or removed destinations cancel that work instead of redirecting it. In-flight network acceptance cannot be undone. Late completion cannot overwrite cancellation. Configuration is loaded on worker startup; restart the API to adopt a replaced secret file. An invalid file fails closed and the worker retries startup every ten seconds; inspect service heartbeat and container logs. When starting the API without a configuration path, old routes are disabled and pending work cancelled.

The worker takes a schema-scoped PostgreSQL advisory lock, starts independently of browser/device startup and runs outside the API/control process. Each delivery acquires a random token and a 30-second database lease. Completion requires a matching unexpired lease. A crash leaves an Unknown attempt, then permits another attempt using the same event identity. Duplicates remain possible: the transport cannot promise exactly-once delivery. The worker closes transport connections on shutdown or database ownership loss. No command authority is granted by a notification restart.

There are at most eight cumulative attempts, including manual retries. Retry delays are 1, 2, 4, 8, 16, 32 and 60 seconds. Only one attempt runs at a time, with at least one second between cycles and a five-second transport deadline. Permanent rejection becomes Dead immediately. Manual retry of a Dead record requires remaining attempts, the unchanged enabled destination, capacity, project ownership, CSRF and a reason saved atomically to audit. Delivered and Cancelled records cannot be retried. Exhausted records retain their logs; manual action cannot reset the counter.

Capacity is 1,000 Pending/Sending records per route. Additional events increment a persistent per-route Dropped counter without failing the alarm transaction; the source alarm event remains in its own journal. Overflow is visible in the UI. Terminal delivery records and cascading attempt logs retain at most 365 days and the most recent 10,000 per destination, pruned in batches of 1,000 once a minute. Retention cleanup is eventual while the worker is running. These are engineering bounds, not a 10,000-device notification throughput claim. Database failures still follow the alarm monitor's existing transaction-fault behavior; transport failures run independently.

The Alarms page polls secret-free route labels, service status, delivery states and attempts, with pages of 20 records. Heartbeats older than ten seconds are shown unavailable. Attempt outcomes distinguish Delivered, Retry, Dead, Unknown and Cancelled; endpoint response bodies never enter logs. Route Dropped totals are workspace totals, including all projects matching that route. HTTP endpoints are `GET /projects/:id/notifications`, `GET /notifications/:id/attempts` and `POST /notifications/:id/retry` under `/api/v1`.

## Local deployment

Create an external JSON file readable by container UID 1000 with mode 0600. Example structure (replace the target and secret before use):

```json
{
  "version": 1,
  "routes": [{
    "id": "local-operations",
    "name": "Operations webhook",
    "kind": "webhook",
    "url": "https://receiver.example.invalid/apcs/events",
    "secret": "replace-with-a-random-secret-at-least-32-characters",
    "priorities": ["high"],
    "events": ["Activated", "Reactivated", "Returned", "Unsuppressed"],
    "projectIds": []
  }]
}
```

Use the existing image and a private bind mount:

```sh
APCS_NOTIFICATION_FILE=/absolute/private/notifications.json docker compose -f compose.yml -f compose.notifications.example.yml up -d api web
```

An SMTP route replaces `url`/`secret` with `host`, `port`, `security`, `from`, `to` and optional `auth`. Use local DNS and CA certificates for offline operation. Paths inside JSON are not dereferenced; a custom CA is PEM text in `ca`. No test message endpoint is provided. A real configured alarm event is the delivery trigger. Source edits use existing API hot reload; no Docker image rebuild is required. Configuration files must stay outside Git and need their own protected backup.

Database backup/restore includes deliveries and attempts but excludes private endpoint configuration. Restored pending/expired work can be sent again if the same configuration is enabled. For restore rehearsal, start without notification configuration; this disables restored routes and cancels active queue records. Retain the original backup when evaluating that cancellation. Alarm monitoring still starts with the current device runtime profile; passive monitor autostart is separate pending work.
