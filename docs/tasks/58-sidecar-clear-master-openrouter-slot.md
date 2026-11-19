# Sidecar: per-master sandbox slot; `openrouter: null` clears it

**Status:** in progress · **Created:** 2026-11-19 · **Updated:** 2026-11-19 · **Priority:** P2
**Plan:** `mcpfantom/docs/plans/2026-11-19-openrouter-direct-workers.md`, sections 0.3-0.5.
**Goes with:** task 59 (same sidecar release).

## Why
Fantom and Sound Suite now call OpenRouter themselves for embedding, rerank and
chat. The only thing a sidecar still needs from a master is what ss-rlm-sandbox
uses: that master's key, its sandbox model and its domain. Today a master
cannot remove its slot: `ws-client.ts` only reads `payload.openrouter` when it
is an object, so `null` is ignored and the key stays in memory and in
`openrouter.enc.json` until the master is retired.

## Contract (both masters)
Config push, per master:

```json
{ "openrouter": { "apiKey": "<only when set>", "allowedModels": { "rlm-sandbox": { "model": "<OpenRouter id>" } }, "domain": "legal" } }
```

- **Object** → store the slot for that master URL. An old master may still
  send the full old block (`embedding`, `reranker`, `modeByRole`, ...): accept
  it and keep only `rlm-sandbox`, `apiKey` and `domain`. No `apiKey` in the
  object → keep the stored key.
- **`null`** → clear that master's slot (memory and `openrouter.enc.json`).
  Log `[<serverUrl>] OpenRouter sandbox slot cleared by master`. Other masters
  keep their slots.
- **Absent** → no change.

The slot lives in memory (process-global) and in `openrouter.enc.json`
(secret-box, as today) and is restored on boot. Old files that hold full
blocks are read and cut to the sandbox fields.

`/api/status`, per master (Fantom reads exactly these to find its slot and
re-push when it is `unset`):

```json
{ "serverUrl": "...", "wsPort": 8098, "virtualInference": { "openrouter": "configured", "domain": "legal" } }
```

`configured` = key **and** sandbox model present; otherwise `unset`.

## Acceptance
- Push `{openrouter: null}` from a test master: no slot in memory, none in the
  store after a restart, the other master's slot unchanged.
- A later object push configures the slot again.
- A full old-style push leaves only the sandbox fields in the slot.

## Tests
`sideCar/src/lib/__tests__/sandbox-slot.test.ts`: set / clear by null /
other master kept / restore after restart / old full block cut down / status.

## Release
Same sidecar release as task 59. Fantom task ORDW-07 waits for it on every host.
