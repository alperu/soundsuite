# TODO — OCR pipeline Phase 2 + CI enforcement

Tracking doc for the follow-up work from the PR #4 review (see issue #5).
Phase 1 (wiring `pipeline.ocrConcurrency` into exhibit extraction, with clamping) shipped separately.
Companion doc with the original latency analysis: [TODO-ocr-speedups.md](./TODO-ocr-speedups.md).

## Phase 2 — OCR robustness

- [x] **Configurable OCR timeout.** Add `timeoutMs?: number` to `OllamaOCRConfig`
      (`src/lib/ingestion/ollama-ocr-engine.ts`), default **90 000 ms**. Do not lower to 45 s until the
      host-health watchdog (TODO-ocr-speedups fix #3) lands — measured latencies: median 30–40 s,
      cold model loads 30–60 s, worst > 115 s. Wire it from admin config at `src/services/worker-init.ts`
      and the reindex route.
- [x] **Distinguish timeout vs host error in retry logs.** In the retry catch
      (`ollama-ocr-engine.ts` ~line 193), log "our timeout fired after Ns" separately from
      Ollama 5xx/connection errors — today both surface as `AbortError`.
- [x] **Surface OCR failures instead of swallowing them.** DONE: `ocrFailedCount` added to
      `ExhibitExtractionResult` (both paths — legacy no longer drops failed exhibits), warned at the
      extractor and pipeline stage boundary, and published as a progress warning.
  - [ ] Remaining: persist a partial-failure marker on the Document record and surface it in the UI
        (e.g. a "N exhibits missing OCR text" badge with a re-OCR action).
- [x] **Split `preprocessConcurrency` from `ocrConcurrency`.** `preprocessQueue` (sharp, local CPU)
      and `ocrQueue` (HTTP to Ollama, GPU/network-bound) want different values; sizing the sharp
      queue from a knob named "OCR Concurrency" misleads. Default `preprocessConcurrency` to
      `ocrConcurrency` for backward compatibility.
- [x] **Backpressure between preprocess and OCR queues.** `ocrQueue.add()` is not awaited by the
      preprocess task, so pending OCR closures each hold a preprocessed PNG buffer — heap pressure
      on large documents at high concurrency. Bound the OCR queue or await when it exceeds a
      high-water mark.
- [x] **Add tests.** `ollama-ocr-engine.ts` has no test file at all. Minimum:
      - fake-timer retry test: 3 attempts, delays within [3000, 4000] and [6000, 7000]
      - timeout-abort test (mock fetch that never resolves)
      - extractor in-flight-ceiling test: mock OCR engine counting concurrent calls for
        `concurrency: 1` vs `4`
      - clamp tests for `0 / -1 / NaN / null / 99`
- [x] **Fix the backoff comment.** With `MAX_RETRIES = 3` only two delays ever fire (3–4 s, 6–7 s);
      the "12 s" third delay never happens. TODO-ocr-speedups.md's worst-case arithmetic repeats the
      same error — correct both.
- [x] **Mark TODO-ocr-speedups items #1 and #2 done** once the timeout work lands (item #1 is done
      by Phase 1). DONE — both marked with resolution notes.
  - [x] Admin UI field for `pipeline.ocrTimeoutMs`: "OCR Timeout" slider (10–600 s) in the
        pipeline settings panel (`processing-progress.tsx`), PATCHed via `/api/config/pipeline`
        (clamped 10 s–10 min). Applies to engines created after the change (worker init reads
        config at startup) — restart processing to pick it up immediately.

## Separate track — CI enforcement

Attempted prematurely in PR #4: main has **69 failing tests across 19 suites** and **11.44% line
coverage**, so removing `continue-on-error` + a 70% threshold would turn every PR red. Correct order:

- [ ] **Stabilize the suite** (69 failures as of 2026-08-05, v1.2.0):
  - [ ] `Cannot find module '@testing-library/dom'` (e.g. `src/components/personas/__tests__/persona-table.test.tsx`)
  - [ ] `src/services/__tests__/job-queue.test.ts` — "Jest worker encountered 4 child process exceptions"
  - [ ] `src/lib/search/__tests__/deep-search-boolean.test.ts` assertion failures
  - [ ] 3 boundary-filtering failures in `src/lib/ingestion/__tests__/exhibit-extractor.test.ts`
  - [ ] remaining suites — run `npm test 2>&1 | grep -E '^FAIL'` for the current list
- [ ] **Remove `continue-on-error: true`** from the Test step in `.github/workflows/ci.yml`
      (only after the suite is green).
- [ ] **Add a coverage ratchet in `jest.config.js`** — not inline in ci.yml:
      `coverageThreshold: { global: { lines: 11, branches: 6, functions: 7 } }` at the real baseline,
      raised over time. Narrow `collectCoverageFrom` away from App Router routes/components so the
      denominator measures library code, not UI.
- [ ] **Raise `testTimeout` to 60 s for CI** — GitHub's 2-vCPU runners are slower than a dev Mac;
      OCR tests that squeak under the 30 s limit locally will flake there.
