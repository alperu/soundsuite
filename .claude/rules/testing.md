---
paths:
  - "**/__tests__/**"
  - "jest.config.js"
  - "jest.polyfills.js"
---

# Testing conventions

- Jest with `ts-jest`, `jsdom` environment, 30 s timeout (OCR tests). Tests are colocated in
  `__tests__/` directories. `@/*` resolves via `moduleNameMapper`.
- **There are no global mocks.** `jest.polyfills.js` (wired via `setupFiles`, so it runs before
  any import is evaluated) supplies `TextEncoder` / `TextDecoder` and nothing else. Every suite
  mocks what it needs itself — assume no ambient `fetch`, logger or `tesseract.js` mock exists.
  - History: a `jest.setup.js` once *described* global mocks for `fetch` / `Request` /
    `Response` / `@/lib/logger` but was never referenced by `jest.config.js`, so it never ran.
    Wiring it in cost 12 suites and 100 failures — its hand-rolled Web API stubs shadow the real
    ones route tests use. It was deleted (task #55). Do not reintroduce it.
- Server-only suites that import native or ESM-heavy modules (e.g. `@lancedb/lancedb`, which
  pulls apache-arrow) declare `@jest-environment node` in a docblock; jsdom is wrong for code
  that never runs in a browser.
- `transformIgnorePatterns` whitelists ESM packages: `chokidar`, `p-queue`, `p-timeout`,
  `eventemitter3`, `@langchain`, `@haxall`, `haystack-core`, `@xenova`. An untransformed ESM
  import dies at parse with "Unexpected token 'export'".
- Fixtures are synthetic (see the privacy rule). A test that needs a real PDF reads its path
  from an env var such as `RR_FIXTURE_PDF` and skips when unset.
- Run one suite with `npx jest path/to/test`; ingestion suites together with
  `npx jest src/lib/ingestion/ --no-coverage`.
