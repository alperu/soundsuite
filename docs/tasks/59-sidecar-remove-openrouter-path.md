# Remove the sidecar OpenRouter proxy; masters and ss-rlm-sandbox call OpenRouter directly

**Status:** in progress · **Created:** 2026-11-19 · **Updated:** 2026-11-19
**Plan:** `mcpfantom/docs/plans/2026-11-19-openrouter-direct-workers.md`, sections 0.3-0.5 and 8.
**Goes with:** task 58 (the sandbox slot stays).

## Decisions (user, 2026-11-19)
- **Sound Suite master** calls OpenRouter itself for embedding, rerank and chat
  with `src/lib/openrouter/client.ts` (no second client). Provider pins, width
  checks and spend accounting stay in that client. It stops sending
  `virtual-embed` and pushes only the sandbox slot (task 58).
- **Sidecar** drops the proxy: embed / rerank / key-info over WS, the
  local-acquire fallback to `virtual-inference`, the `/api/v1/chat/completions`
  route and the "Virtual Containers" UI. It keeps the per-master sandbox slot.
- **ss-rlm-sandbox** calls `https://openrouter.ai/api/v1/chat/completions`
  itself with the calling master's key. It gets `{key, model, domain}` from a
  local hand-off endpoint on the sidecar.

## Hand-off endpoint (sidecar → sandbox)
`GET /api/rlm-sandbox/master-config?master=<master URL>`

- Auth: header `X-Sandbox-Token` must equal the token the sidecar passes to the
  container as env `SS_SANDBOX_TOKEN`. The token is derived from the sidecar's
  data key (`purposeKey('rlm-sandbox-token')`), so it is stable across sidecar
  restarts and container re-creates. Missing or wrong → 401.
- `master` absent → the old rule: the one master with a usable slot, 409 when
  there are several.
- 200: `{ "master": "<url>", "apiKey": "<key>", "model": "<id>", "domain": "legal"|"code"|null }`
- Errors: `{ "error": { "message", "code" }, "handoff": true }` plus header
  `X-Sandbox-Handoff: 1`. 404 = master has no slot, 409 = ambiguous, 503 = no
  key or no sandbox model.
- The sandbox returns 409 to the master as 409, every other hand-off error as
  502, so the master still fails over to another host as before.
- Container env is stripped from `/api/status`, `/api/containers` and the WS
  `containers` reply (it holds the token).
- A 404 **without** the marker means an older sidecar with no such route; only
  then does the sandbox fall back to the old sidecar chat route.
- Sandbox caches the answer per master for 60 s. The key is never logged.

## Implementation

### Files
Master (`src/`):
- `lib/gpu/fleet-router.ts` `buildOpenRouterPush()` → sandbox slot only;
  `null` when OpenRouter is off or has no key (a new sidecar then clears the slot).
- `lib/ingestion/all-sources-embedding-provider.ts` → cloud share calls
  `OpenRouterEmbeddingProvider.embed()` (pinned, width-checked, charged).
- Delete `lib/gpu/virtual-embed-dispatch.ts` and its test; delete
  `lib/openrouter/__tests__/sidecar-constants-drift.test.ts` (the sidecar no
  longer holds embedding pins).
- Rerank and chat already call the client directly; comments only.

Sidecar (`sideCar/src/`):
- New `lib/sandbox-slot.ts` (set / clear / restore / status / resolve).
  `openrouter-store.ts` and `secret-box.ts` stay; the store keeps its file
  format so an older sidecar can still read it on rollback.
- Delete `lib/virtual-inference.ts`, `lib/openrouter-client.ts`,
  `app/api/v1/chat/completions/route.ts`, `components/virtual-container-table.tsx`.
- `lib/ws-client.ts`: drop the three `virtual-*` actions (an old master gets
  `Unknown action`), `null` clears the slot.
- `lib/handlers.ts`: drop the cloud fallback in acquire and the `virtual*`
  handlers; status reports the slot.
- New `app/api/rlm-sandbox/master-config/route.ts`.
- `lib/docker.ts`: pass `SS_SANDBOX_TOKEN` and `SS_SIDECAR_URL` to the
  container; token value redacted in drift messages.
- Image pin `ghcr.io/project-sandstar/rlm-sandbox:0.1.3` in `state.ts` and
  `mode-templates.ts`.

Sandbox (`docker/rlm-sandbox/server.py`): fetch the master config, call
OpenRouter directly with `usage: {include: true}`, fall back on a bare 404.

### Order
1. This doc.
2. Master, sidecar, sandbox code; tests and type checks pass.
3. Build and push the sandbox image `0.1.3` (multi-arch, public) **before** the
   sidecar release, or hosts on the new sidecar cannot pull it.
4. Deploy the Sound Suite master.
5. Sidecar release (`buildSidecar.sh patch`, then fleet update).

### Rollback
- Master: previous release.
- Sidecar: previous release; `openrouter.enc.json` keeps the old format, so
  2.7.8 restores the slots. 2.7.8 pins image `0.1.2`, which uses the chat route.
- Sandbox image `0.1.3` on an old sidecar works through the 404 fallback.

### Tests
- Sidecar: `sandbox-slot.test.ts` (slot rules, restore, resolution, and the
  hand-off route: token, 404 marker, 409, 200), `container-cmd-drift.test.ts`
  (token expected, redacted in drift text), existing pin tests.
- Master: `openrouter-push.test.ts` (sandbox-only shape),
  `all-sources-embedding-provider.test.ts` (direct cloud share).
- Sandbox: `python3 -m py_compile server.py`; no Python test suite exists.
- Still open: the docs `docs/ss-rlm-sandbox/01-how-it-works.md` and
  `02-fantom-integration.md` describe the old chat route.

## Follow-up
- Remove the sandbox's 404 fallback to the sidecar chat route once every host
  runs this release.
- Delete `openrouter.enc.json` handling only if the sandbox slot moves elsewhere.

## Acceptance
- `rg -n "virtual-embed|virtual-rerank|virtual-key-info|openrouter-client" sideCar/src` finds nothing.
- Local roles (embedding, code-embedding, reranker, completion, OCR) still serve.
- A master that still pushes the full `openrouter` block gets no error.
- `/api/status` per master: `serverUrl`, `wsPort`, `virtualInference.openrouter`.
