# TASK: Sidecar /netbird — "Connect NetBird" button, failures in the Overview logs

Asked 2026-11-17, after `http://100.114.192.119:8098/netbird` did not connect.
Docs: `sideCar/docs/NETBIRD.md`, endpoints in `sideCar/docs/API.md`.

## Done
- [x] **Connect NetBird button** on `/netbird` → `POST /api/netbird/connect`
      (`connectNetbirdNow()` in `sideCar/src/lib/netbird-runtime.ts`): removes
      `<self>-netbird`, reconcile makes it again; peer identity kept. — 2.7.7
- [x] **NetBird/HTTPS events in the Overview Activity Log** (`reportNetbird()`,
      via `emitBootEvent`), once per change: container changes, reconcile errors,
      NetBird container log errors (`ERRO` lines, read only while not connected),
      connected / not connected, 0-peers warning. — 2.7.7
- [x] Master sockets stuck on the Docker address after an update (host shows
      offline): reconnect all after NetBird starts, 45 s dead-socket check. — 2.7.5
- [x] NetBird pulled for the host platform (Apple Silicon:
      `wgctl: socket: protocol not supported`). — 2.7.4
- [x] sidecarmaster `/gpu` and Hosts show each host's NetBird HTTPS URL
      (sidecar 2.7.6 heartbeat `netbird`, sidecarmaster `6da2abf`).
- [x] Test token, Start HTTPS now, Caddy built on the host, Caddy errors on the
      page, P2P/Relayed peers, favicon. — 2.7.0 … 2.7.3

## Open
- [ ] `POST /ws-connect` / `/ws-disconnect` need no login; `ws-disconnect`
      removes a master. Put them behind `requireAdmin` (check who calls them first).
- [ ] sidecarmaster: show the sidecar's NetBird state (connected, peers, HTTPS
      state) next to the HTTPS link, from the same heartbeat field.
