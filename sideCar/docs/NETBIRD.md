# NetBird and HTTPS

The sidecar can join a NetBird network and serve itself over HTTPS at
`https://<hostname>.<domain>` (for example `https://sidecar-alper-mac-mini.vpn.bas.co`).
Set it up on the **NetBird** page (`/netbird`). Needs the sidecar to run in Docker.

## How it works

The sidecar starts two companion containers in its own network namespace:

| Container | What it does |
|---|---|
| `<self>-netbird` | NetBird client (`netbirdio/netbird`). Gives the sidecar a NetBird IP and name. Pulled for the host's own platform (arm64 on Apple Silicon). |
| `<self>-caddy` | Caddy with the Cloudflare DNS module. Gets a Let's Encrypt certificate through a Cloudflare DNS check (no open port) and proxies HTTPS to the sidecar. |

The Caddy image (`sidecar-caddy-cf:1`) is built on the host by the sidecar the
first time HTTPS is on (2–3 minutes). It does not download from `caddyserver.com`.
`SIDECAR_CADDY_IMAGE` pulls a ready image instead.

A reconcile loop (every 60 s, and at once after a change) keeps both containers
as the settings say. Secrets (setup key, Cloudflare token) are stored encrypted.

## The NetBird page

| Control | What it does |
|---|---|
| Setup key, Hostname, Save | Join NetBird. Key: letters, digits and dashes, 20–100 characters (from **Setup Keys** in the NetBird dashboard, not a `nbp_` access token). |
| **Connect NetBird** | Make the NetBird container again and connect now. The peer identity is kept. |
| Turn off / Remove key | Leave NetBird. |
| Domain, Cloudflare API token, Save and turn on HTTPS | HTTPS for `https://<hostname>.<domain>`. Token: Zone → DNS → Edit on the zone of the domain. |
| **Test token** | Checks the token the way Caddy uses it: active, sees the zone, can add and remove a TXT record. Nothing is saved. |
| **Start HTTPS now** | Restart Caddy so it asks for the certificate now, not at its next retry. |

The **Status** card shows the NetBird IP, management state, and each peer with
its connection type (**P2P** direct or **Relayed**) and latency. The **HTTPS**
card shows the certificate, the image build, and the last Caddy error.

## Activity Log (Overview page)

NetBird and HTTPS events go to the Activity Log on the Overview page, once per
change:

- container changes: `NetBird: created`, `HTTPS (Caddy): restarted`, …
- errors from the reconcile or the container log, for example
  `NetBird error: failed creating tunnel interface wt0: …` or `HTTPS (Caddy) error: …`
- `NetBird connected as <fqdn> (<ip>), <n>/<m> peers`, or `NetBird not connected`
- `NetBird gives this peer 0 peers: …` when no access policy lets it reach anyone

## Masters

The heartbeat sends `netbird { fqdn, ip, connected, httpsUrl, httpsState }`, so
sidecarmaster shows the HTTPS URL on `/gpu` and the Hosts page.

When NetBird starts or restarts, the sidecar waits until it is connected and then
reconnects every master socket. Sockets opened before NetBird was up keep the
Docker bridge address and cannot reach a master on the NetBird network. Each
socket also pings every 5 s; a socket with no reply for 45 s is dropped and
reconnects.

## Troubleshooting

| Symptom | Cause and fix |
|---|---|
| `wgctl: socket: protocol not supported` | NetBird runs under emulation (amd64 image on Apple Silicon). Fixed in 2.7.4: NetBird is pulled for the host platform. **Connect NetBird** makes it again. |
| Connected, but 0 peers; nobody reaches the HTTPS URL | The peer is in no group with an access policy. Approve it and add it to a group in the NetBird dashboard. |
| Caddy: `download failed … HTTP response to HTTPS client` | The network blocks `caddyserver.com`. Fixed in 2.7.0: the image is built on the host. |
| Caddy: `timed out waiting for record to fully propagate` | NetBird DNS answers the NetBird domain itself. The Caddyfile uses public resolvers and skips Caddy's own propagation check (2.7.2). |
| Caddy: `An identical record already exists` | A record left by an earlier try. It clears by itself; **Start HTTPS now** tries again. |
| Host shows offline on the master after an update | Master sockets stuck on the Docker address. Fixed in 2.7.5 (reconnect after NetBird starts, 45 s dead-socket check). |
