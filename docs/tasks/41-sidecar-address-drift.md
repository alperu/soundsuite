# A sidecar's advertised address is pinned at first boot and never revalidated

**Status:** Proposed · **Effort:** M · **Priority:** P1 · **Created:** 2026-09-13
**Reported:** `mcpserver.local` advertised `http://192.168.88.242:8098` after DHCP
moved the host to `192.168.88.238`. Restarting the sidecar did not correct it.
**Interacts with:** [task 39](./39-role-aware-readiness.md) (a role on an
unreachable host is not a role that is down) · [task 30](./30-mcp-parity-and-fleet-visibility.md)

Field names and code citations only. No case data.

## Verified before writing (2026-09-13)

Both halves of the reporter's hypothesis hold. Re-confirm in item 1 before
building — but these were read from source, not inferred.

### Sidecar: a saved address outranks reality

`sideCar/src/lib/ws-client.ts:51-70`, in order:

```ts
export function getAgentUrl(): string {
  if (process.env.AGENT_URL) return process.env.AGENT_URL;
  if (state.savedAgentUrl) return state.savedAgentUrl;        // <-- wins
  if (process.env.EXTERNAL_IP) return `http://${process.env.EXTERNAL_IP}:${PORT}`;
  // ...only now scan os.networkInterfaces()
}
```

`state.savedAgentUrl` is loaded from the persisted config at boot
(`config.ts:90-91`, "Loaded saved agent URL"), written back at `config.ts:206`,
and announced at `instrumentation.ts:145-146` ("Resuming with saved agentUrl").

**Nothing compares it against `os.networkInterfaces()`.** The three call sites are
`ws-client.ts:56` (only reached when `savedAgentUrl` is null), `handlers.ts:49`,
and `instrumentation.ts:33`. So the value is sticky for the life of the config
file, which is exactly why a restart did not help: boot reloads the stale value
before any detection runs.

### Master: identity *is* the address, and there is no update path

`src/lib/gpu/ws-relay.ts:291` keys the registry by the advertised address:

```ts
sidecars.set(msg.agentUrl, { ws, agentUrl: msg.agentUrl, hostname: ..., ... });
```

`hostname` is carried as a display field only. Grep for an update / rename /
migrate path over `agentUrl` in `src/app/api/admin/host-provisioning/route.ts` and
`src/app/api/admin/gpu-fleet/route.ts` returns **nothing**.

**Consequence:** if the sidecar ever does advertise a corrected address, the master
gains a *second* entry rather than updating the first, and the stale one persists
through `persistSidecarList()`. Fixing only the sidecar converts a wrong-address
bug into a duplicate-host bug.

## Why this is worse than a cosmetic display issue

The advertised address is what the master **calls**. `resolveEndpoint` hands it to
the data path, and `ollama-embedding-provider` and the rerank/RLM clients connect
to it directly. A stale address means:

- Every acquire against that host fails, or worse, hangs until a timeout.
- Under [task 39](./39-role-aware-readiness.md)'s role checks the host's roles read
  as **present** — the fleet reports it, so `checkRoleAvailability` sees a running
  container. Reachability and reported-status are different claims, and right now
  only one of them is made.
- With admission control ([task 40](./40-fleet-admission-control.md)) a host that
  cannot be reached still absorbs selection, because selection reads cached load.

## The hard part: what is a sidecar's identity?

Do not answer this by reflex. Each candidate is wrong in a different way.

| Candidate | Fails when |
|---|---|
| `agentUrl` (today) | DHCP moves the host — the reported bug |
| `hostname` | two hosts share a name (`localhost`, a cloned VM, two `mcpserver.local` on different subnets); also mutable |
| container id | changes on `docker rm` / recreate, which the auto-updater does |
| a generated persistent id | needs somewhere durable to live, and must survive config reset without colliding after a clone |

A generated id stored beside the config is probably right, but it inherits the
same staleness question the address has: a cloned VM carries its source's id. Any
choice must say what happens when two sidecars present the same identity.

## Work

| # | Item | Status |
|---|---|---|
| 1 | **Confirm before building** (four premises of v12 and three of v14 were refuted this way). Re-verify `ws-client.ts:51-70`, `config.ts:90-91,206`, `instrumentation.ts:145-146`, `ws-relay.ts:291`, and that no master route updates `agentUrl`. Also find **where `savedAgentUrl` is first written** — only the load path is visible, so the original writer is unidentified. If nothing writes it, the `.242` value came from an older build and that changes the migration story. | ☐ |
| 2 | **Decide whether a saved address should outrank detection at all.** The likely answer is no: make detection primary and treat the saved value as a fallback for when detection yields nothing useful. `AGENT_URL` and `EXTERNAL_IP` **must keep winning** — operators set those deliberately for NAT and multi-homed hosts, and breaking that is worse than the bug being fixed. | ☐ |
| 3 | **Revalidate at boot and on a timer.** At startup and every N heartbeats, compare the advertised address against `os.networkInterfaces()`. If the advertised host is not a local address, re-detect and re-advertise. Log the change loudly with both values — a silent address change is its own debugging problem. | ☐ |
| 4 | **Do not let a Docker-internal address win.** `ws-client.ts:58-62` already skips `172.17.`/`172.18.` and keeps them only as a last-resort fallback. Any re-detection must preserve that, or a containerised sidecar will advertise an address only it can reach. | ☐ |
| 5 | **Add a master-side reconcile path.** Same identity (item 6) arriving on a different `agentUrl` must **update** the entry, not create a second one: move the registry key, migrate `roles`/`vram`/`activeRequests`, close the old socket, and persist. This is where the duplicate-host bug gets prevented. | ☐ |
| 6 | **Choose the identity and write down what a collision does.** See the table above. Whatever is chosen, two sidecars presenting the same identity must produce a visible, named conflict rather than one silently replacing the other. | ☐ |
| 7 | **Give the operator a manual override.** `/admin/hostprov` already edits per-host master URL and WS port; add the ability to correct or forget a stale address, so recovery does not require editing a config file inside a container. | ☐ |
| 8 | **Distinguish unreachable from unreported.** A registry entry whose address does not answer should be visibly unreachable, not merely stale-looking. This is the same rule as [task 39](./39-role-aware-readiness.md): reported-status and reachability are separate claims, and the fleet currently only makes the first. | ☐ |
| 9 | Tests: a saved address that is no longer local is replaced; `AGENT_URL` still wins; a Docker-internal address is not preferred over a LAN one; a re-register from a new address updates rather than duplicates; a colliding identity is reported. | ☐ |
| 10 | **Clean up the entry that is already wrong.** `mcpserver.local` is registered at `.242` today. The fix must either migrate it or make removing it possible without hand-editing persisted state. | ☐ |

## Risks

- **Re-detection on a multi-homed host can pick the wrong interface.** The current
  code returns the *first* non-internal IPv4 it finds, which is arbitrary on a host
  with several. Re-detecting more often makes that instability more visible, not
  less. Prefer the interface that can reach the master over the first one listed.
- **A flapping address is worse than a stale one.** If detection disagrees with
  itself between runs, the master will see the identity move back and forth and
  (with item 5) migrate state each time. Require stability before re-advertising.
- **Changing the registry key touches persistence.** `persistSidecarList()` and the
  `data/` records both carry `agentUrl`. A migration that half-completes leaves two
  records for one host, which is the bug this task exists to prevent.
- **Do not break the deliberate pin.** A host behind NAT advertises an address that
  is *not* one of its local interfaces, and that is correct. Item 3's "is it local?"
  test must not fire when `AGENT_URL` or `EXTERNAL_IP` is set.

## Acceptance

| Check | Expected |
|---|---|
| DHCP moves a sidecar host | the master reaches it again without operator action, within a stated bound |
| The same host after the move | **one** registry entry, not two |
| `AGENT_URL` set to a non-local address | honoured, never overridden |
| A containerised sidecar with only a `172.17.x` address | does not advertise it while a LAN address exists |
| Two sidecars with the same identity | a named conflict, not silent replacement |
| A registered address that does not answer | reported unreachable, distinct from unreported |

## References

- `sideCar/src/lib/ws-client.ts:51-70` (`getAgentUrl`), `:162` (register payload), `:1022-1024`
- `sideCar/src/lib/config.ts:90-91` (load), `:206` (persist)
- `sideCar/src/instrumentation.ts:145-146` (resume log), `:33` (interface scan)
- `sideCar/src/lib/handlers.ts:49` (interface scan), `:1076` (status exposure)
- `src/lib/gpu/ws-relay.ts:291` (registry keyed by `agentUrl`), `persistSidecarList()`
- `src/app/api/admin/host-provisioning/route.ts` — per-host master URL / WS port, no address update
- `src/app/api/admin/gpu-fleet/route.ts` — fleet read surface
