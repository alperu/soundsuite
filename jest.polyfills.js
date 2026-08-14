// Runs via `setupFiles`, i.e. BEFORE the module registry loads any test's
// imports. That ordering is the whole point: apache-arrow (pulled in by
// @lancedb/lancedb) reads TextDecoder at import time, and jsdom doesn't
// provide one, so a suite importing it died on the import line before any
// hook in `setupFilesAfterEnv` could have run.
//
// Deliberately ONLY polyfills. The previous jest.setup.js also replaced
// fetch / Request / Response / Headers with hand-rolled stubs and mocked the
// logger — measured against the full suite, wiring those in cost 12 suites and
// 100 test failures, because the stubs shadow the real Web APIs that route
// tests rely on. Polyfills alone recovered 41 tests that had never executed
// and broke nothing. See task #55 for the A/B numbers.
//
// Guarded assignment: never clobber an environment that already supplies them
// (the `node` test environment does).
const { TextEncoder, TextDecoder } = require('util');

global.TextEncoder = global.TextEncoder || TextEncoder;
global.TextDecoder = global.TextDecoder || TextDecoder;
