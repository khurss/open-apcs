# Local network testing

This optional development profile serves the existing workspace over HTTPS with Vite HMR and API watch. It uses the same `open-apcs-dev` project and persistent database as `make dev`; it does not create an independent installation. Do not run it alongside a separate deployment with that project name. The Vite development server is intended for a trusted test LAN, not internet exposure or production.

## Initial setup

Install the development dependencies and images as described in [development](development.md). Set the server's numeric LAN IPv4 address in an ignored `.env.lan` file:

```dotenv
APCS_LAN_HOST=192.168.1.10
APCS_LAN_PORT=8443
```

Replace the example address with the server's address. Keep it stable using your network's DHCP reservation or static addressing. Generate a local test certificate on the host, replacing the address below with the same value:

```bash
mkdir -p .cache/lan/tls
chmod 700 .cache/lan/tls
openssl req -x509 -newkey rsa:3072 -sha256 -nodes -days 365 \
  -keyout .cache/lan/tls/server.key -out .cache/lan/tls/server.crt \
  -subj '/CN=Open APCS LAN development' \
  -addext 'subjectAltName=IP:192.168.1.10,IP:127.0.0.1,DNS:localhost'
chmod 600 .cache/lan/tls/server.key
make lan
```

The development container runs as UID 1000 and must be able to read the key. The certificate directory is mounted read-only; keys and local settings are ignored by Git. Never share `server.key`. Store bootstrap passwords outside the workspace (for example under `~/.local/share/open-apcs`), not in frontend assets or repository files. Vite denies access to local caches, credentials and workspace-generated artifacts. Alternatively, install a certificate issued by your local trusted CA at the same paths. Renew the certificate before expiry and restart the web service to load it.

Open `https://192.168.1.10:8443` from a device on the same network. A self-signed certificate produces a browser warning until explicitly accepted or trusted on that device. Use only the configured address and port: API mutation requests require that exact Origin. HTTPS enables Secure session cookies and the browser's secure-context APIs used by the editors; plain HTTP LAN access is not supported. The backend port remains loopback-only, and PostgreSQL, MQTT and the isolated workers have no published ports.

Create the first administrator using [API startup](api.md) if this database has no account. There is no shared default password. Existing accounts and data are preserved. Start with a virtual LED or virtual thermal device; physical hardware requires its separate commissioning workflow.

## Operation

```bash
make lan-status
make lan-stop
make lan
```

No image is rebuilt by `make lan`. Source edits remain bind-mounted and browser updates use a secure WebSocket on the same HTTPS port. Services restart after Docker/host restarts unless explicitly stopped; equipment still requires deliberate operator activation. Docker itself must start on boot. Use `make lan` instead of `make dev` while testing through the network: `make dev` restores the loopback HTTP configuration and its Origin.

To return to loopback development, run `make dev`; the persistent database is retained. To change the LAN address or HTTPS port, update `.env.lan`, regenerate the certificate if its address changed, and run `make lan` again. Allow the chosen TCP port through any host/LAN firewall for the intended test clients. Do not forward this development port from the internet.

## Deployment verification

Verify the HTTPS page and `/api/v1/health/live` through the LAN address, then sign in from a browser. Test a project, a virtual device and a graph/HMI draft. A host-side check alone cannot prove another device's routing or firewall path. The generated certificate can be supplied to `curl --cacert .cache/lan/tls/server.crt` for a verified local connection rather than disabling certificate validation globally.
