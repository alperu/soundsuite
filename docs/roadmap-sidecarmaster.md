# Roadmap: sidecarmaster

**Status:** Proposed · **Created:** 2026-10-30
**Design:** [`SPEC-sidecarmaster.md`](./SPEC-sidecarmaster.md) · **Tasks:** [`tasks/57-sidecarmaster.md`](./tasks/57-sidecarmaster.md)

Scope: the **management sidecar** (`sideCar/`, Docker/GPU). The fileSystem sidecar is not in scope.
Each phase ships on its own. Sound Suite's master code stays in place in every phase.

| Phase | Name | Outcome | Milestone (done when) | Tasks |
|---|---|---|---|---|
| 0 | Decide | Open questions answered (SPEC §15) | User approves the spec | 0.1 |
| 1 | Service shell | Repo, Docker image, stack on basws42 with NetBird + HTTPS, login | `https://sidecarmaster.vpn.bas.co` shows a login page with a valid cert | 1.1–1.5 |
| 2 | Move the master (read-only) | Relay, queue, status cache moved; DB imported from Sound Suite; sidecars added as extra master (protocol v1) | Fleet page lists all 5 hosts live; Sound Suite still works unchanged | 2.1–2.6 |
| 3 | Control + app registry | Roles, host provisioning, per-app mode catalogs, reconcile loop; Sound Suite `follow` switch | Change a role in sidecarmaster → container starts; Sound Suite in `follow` routes on it; switch back to `local` works | 3.1–3.7 |
| 4 | Auto masters (protocol v2) | Join + host token, `masters` frame, `wsUrl`/wss, per-app policy namespace, drift healing | All hosts on sidecar v2; a removed master on a host comes back within 60 s; no script used for 2 weeks | 4.1–4.7 |
| 5 | Dashboard + alerts | Host/app pages, samples, alert rules, notifiers, `/metrics` | Pull a host's network → alert in under 2 min; clears on return | 5.1–5.5 |
| 6 | Retire + extend | Delete `configure-sidecar-masters*.sh`; Fantom uses the API; optional stack deploy | Scripts gone; Fantom fleet data from sidecarmaster | 6.1–6.4 |

## Order and dependencies

```
0 ─► 1 ─► 2 ─► 3 ─► 4 ─► 6
               └──► 5 (can start after 2; alerts need 2's heartbeats)
```

## Rollout order for hosts (phase 4)

Mac-mini → mcpserver → BASWS35 → BASWS41 → BASWS34. One host per day. Freeze switch ready.

## Rollback per phase

See SPEC §13. Short form: every phase can be undone by one switch or one `docker compose down`;
Sound Suite tables are never deleted.
