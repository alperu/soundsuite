# Sidecar: remove the OpenRouter ("virtual inference") path

**Status:** BLOCKED on a user decision · **Created:** 2026-11-19
**Plan:** `mcpfantom/docs/plans/2026-11-19-openrouter-direct-workers.md`, section 8.

## Blocker
Sound Suite still uses this path:
- `src/lib/gpu/fleet-router.ts:978` `buildOpenRouterPush()` pushes its key and models.
- `src/lib/gpu/virtual-embed-dispatch.ts` sends `virtual-embed` shares.
- `docker/rlm-sandbox/server.py:49` `SS_SIDECAR_URL` → sidecar `/api/v1/chat/completions`.

Do this only after Sound Suite calls OpenRouter from its master (it already has
`src/lib/openrouter/client.ts`) and the RLM sandbox points at the master, or the
user decides to keep the path for Sound Suite.

## Remove (sideCar/)
- `src/lib/virtual-inference.ts` (730), `src/lib/openrouter-client.ts` (231),
  `src/lib/openrouter-store.ts` (141); keep `secret-box.ts` (other tokens use it).
- `src/lib/ws-client.ts`: actions `virtual-embed`, `virtual-rerank`,
  `virtual-key-info` (383-385); `payload.openrouter` handling (483);
  `clearOpenRouterConfig` in `retireMaster` (1822).
- `src/lib/handlers.ts`: fallback to `virtual-inference` in local acquire
  (627-690, incl. `isCloudOnly`), `virtualInference` in status (1224),
  `handleVirtualEmbed/Rerank/KeyInfo` (1260-1330).
- `src/app/api/v1/chat/completions/route.ts`.
- `src/instrumentation.ts:88-96` restore.
- UI: `src/components/virtual-container-table.tsx`, its use in `src/app/page.tsx`.
- `src/lib/state.ts` rlm-sandbox comments/role if the container goes too.
- Tests: `src/lib/__tests__/virtual-*.test.ts` (4 files).
- Delete `openrouter.enc.json` on boot once (log it).
- Docs: `sideCar/docs/API.md`, `ARCHITECTURE.md`, `CONFIGURATION.md`, README.

## Acceptance
- `rg -n "openrouter|virtual-inference" sideCar/src` finds nothing but comments you meant to keep.
- Local roles (embedding, code-embedding, reranker, completion, OCR) still serve.
- A master that still pushes `openrouter` gets no error (field ignored).
