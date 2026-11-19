# Sidecar: let a master clear its own OpenRouter slot

**Status:** open · **Created:** 2026-11-19 · **Priority:** P2
**Why:** Fantom (mcpfantom) will call OpenRouter itself and stop pushing its key
to sidecars. Plan: `mcpfantom/docs/plans/2026-11-19-openrouter-direct-workers.md`.
Fantom's old key must not stay on the sidecars. Today there is no way to remove
it: `ws-client.ts:483` only accepts `payload.openrouter` when it is an object, so
`null` is ignored, and the key stays in memory (`G.byMaster`) and in
`openrouter.enc.json` until the master's slot is retired.

Sound Suite is not affected: its pushes still carry an object.

## Change
- `src/lib/ws-client.ts` config push: `payload.openrouter === null` →
  `clearOpenRouterConfig(m.serverUrl)` (already deletes from memory, persists via
  `saveOpenRouterStore`, and drops stats). Object → as now. Absent → no change.
- Log one line: `[<serverUrl>] OpenRouter config cleared by master`.
- `/api/status`: that master then shows `openrouter: 'unset'` and no virtual containers.

## Acceptance
- Push `{openrouter: null}` from a test master: `G.byMaster` has no entry for it,
  `openrouter.enc.json` has no entry after restart, the other master's entry is unchanged.
- A later push with an object configures the slot again.

## Tests
- `src/lib/__tests__/virtual-inference.test.ts`: clear by null, other master kept, restore after restart does not bring it back.

## Release
Ship in the next sidecar release. Fantom task ORDW-07 waits for it on every host.
