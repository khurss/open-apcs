# Local API and catalog increment

The Fastify API provides local authentication, projects, a basic LED device/signal catalog, audit records, and access to the durable command service. This is part of M0. The development process supports explicit virtual-device startup through a private worker. Physical profiles require separate explicit [bench commissioning](physical-commissioning.md) and are disabled without private server configuration. See [runtime operation](runtime.md). Integration tests connect the API to the real MQTT gateway and simulator through explicit trusted application callbacks.

## Development startup

```bash
make install-dev
make dev
```

The API listens on `http://localhost:3100`; `API_PORT` changes the published host port. Its container uses port 3000. PostgreSQL has a persistent development volume and no published host port. The existing test project retains its separate temporary PostgreSQL, network, and volumes. Development credentials in Compose are local fixtures, not a production configuration.

`tsx watch` restarts the API on source changes through the bind mount. Dependency installation and image rebuilds are not part of reload. The API retains sessions/configuration in PostgreSQL across process restarts. Stopping development with `make dev-stop` preserves volumes.

Create the first administrator locally, supplying the password through stdin rather than a command-line argument or a committed environment file:

```bash
read -rsp 'Administrator password: ' APCS_BOOTSTRAP_INPUT
printf '\n'
printf '%s' "$APCS_BOOTSTRAP_INPUT" | docker compose exec -T api pnpm --filter @open-apcs/api exec tsx src/admin.ts operator
unset APCS_BOOTSTRAP_INPUT
```

The username is the final argument. Passwords must contain 12–256 characters. Bootstrap is serialized and allowed only when no account exists; there is no unauthenticated HTTP registration endpoint or shared default password. Password reset/recovery and additional roles remain future work.

## Authentication and request boundaries

Passwords use Node's asynchronous scrypt with independent 32-byte salts and parameters N=32768, r=8, p=3. This parameter combination follows the [OWASP password-storage guidance](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html). Login computes a dummy KDF for unknown users and compares derived keys in constant time. Hashing inputs are bounded.

Sessions use random 32-byte tokens; PostgreSQL stores token hashes and an eight-hour expiry. Cookies are HttpOnly and SameSite=Strict; HTTPS deployments require Secure cookies. Insecure cookies are permitted only for loopback origins. Logout revokes the server-side record. Login is limited to five attempts per minute per client IP by the current API process; multi-node rate limits are not implemented.

Every mutation requires the exact configured Origin. Authenticated mutations also require the session's `X-CSRF-Token`, returned by login or `/auth/me`. There is no permissive CORS policy. The configured development origin is `http://localhost:5173`, used by the web client. Direct API clients must supply it explicitly. Request bodies are limited to 64 KiB, validated against application-owned JSON Schemas, and reject unknown fields or type coercion. User schemas are never compiled by Fastify. See [Fastify validation](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/) and the [cookie plugin](https://github.com/fastify/fastify-cookie).

Graph/HMI drafts, prepared revisions, and simulation routes are described in [editor contracts](editors.md).

## Implemented routes

All paths use `/api/v1`.

| Route | Behavior |
|---|---|
| `GET /health/live` | Public process liveness |
| `GET /health/ready` | Authenticated database readiness |
| `POST /auth/login` | Local credentials → session cookie and CSRF token |
| `GET /auth/me` | Authenticated identity and CSRF token |
| `POST /auth/logout` | Revoke current session |
| `GET/POST /projects` | Cursor-paged list and audited creation |
| `GET/PATCH /projects/:id` | Read and rename; PATCH requires If-Match revision |
| `GET/POST /devices` | List and create a virtual-led or esp32-led catalog entry |
| `GET /signals` | List the device output signals |
| `GET /signals/:id/value` | Current state from a trusted reader, otherwise Disconnected/null |
| `GET /audit` | Newest-first audit with bounded cursor pagination |
| `POST /commands` | Validate input, derive actor from session, persist Accepted/Rejected outcome |
| `GET /commands/:id` | Durable command state and transition history |

Project/device/signal lists default to 100 items and accept a limit of 1–100. Device creation atomically creates its boolean output and audit entry. A site/device MQTT address must be unique. Bench GPIO review is matched against the private server allowlist. Device editing and profiles beyond the initial LED types are not yet implemented. Virtual startup is documented in the runtime contract.

Project updates return ETag and require the matching If-Match revision. Missing revision returns 428; a conflicting revision returns 412. Configuration mutation and audit insertion share a transaction; an audit failure rolls back the mutation. Audit is application-append-only, not protected against a database administrator.

Commands require `Idempotency-Key`; callers cannot supply a trusted actor ID. The HTTP 202 response reports a persisted command outcome, not physical success. Repeated actor/key/payload returns the original ID; conflicting payload returns 409. The journal records the authenticated actor. No callback means no commissioned output, so requests are recorded as Rejected. API-level authentication does not replace the gateway's dispatch-time interlocks, ownership, revision, session, and freshness checks.

## Verification and remaining work

Docker tests verify salted credentials, bootstrap concurrency, migration checksums, session persistence/expiry/logout, origin and CSRF rejection, login throttling, strict input validation, pagination, optimistic revisions, atomic device/signal/audit creation, rollback on audit failure, command idempotency, and authenticated API → PostgreSQL → MQTT → virtual LED → Verified execution. API process reload and its health endpoint were also checked inside Docker.

The web workspace, private simulation runtime, prepared graph activation, and foundation offline bundle are now available. TLS bench commissioning now has protocol-simulator coverage. Still pending: physical HIL, durable deployment supervision, password recovery, detailed roles, WebSocket streaming, OpenAPI export, the complete production offline distribution, production broker/TLS configuration, and the remaining roadmap. M1 remains partial.
