# Chaos test harness — host-Ollama failure modes

Operator-driven harness for the Sound Suite sidecar's `runtime: 'host'` path.
**Not** run in CI: it needs a real Mac with native Ollama installed and uses
destructive system actions (`brew services stop`, `pkill -9`, etc).

## Why not CI?

- Requires native Ollama on the host (CI runners don't have one).
- Stops/starts system services (`brew services stop ollama`, `systemctl stop`).
- Sends `SIGKILL` to `ollama serve` mid-operation.
- Mutates the user's installed-model cache (pull / delete).

CI safety is a non-goal. This is for the operator wiring up a new dev box,
or debugging a regression in the watchdog / activeRequests / idle-timer
state machines.

## Prerequisites

1. **Native Ollama installed and runnable.**
   ```bash
   brew install ollama
   brew services start ollama
   curl -s http://localhost:11434/api/tags | jq .
   ```
2. **Bound on `0.0.0.0:11434`** so the sidecar (running in Docker) can reach
   it via `host.docker.internal`:
   ```bash
   launchctl setenv OLLAMA_HOST 0.0.0.0:11434
   brew services restart ollama
   ```
3. **Sidecar running** with host-routing enabled:
   ```bash
   SS_HOST_OLLAMA=1 \
   SS_HOST_OLLAMA_ROLES=embedding,completion \
   npm --prefix sideCar run dev
   ```
4. **Embedding model pre-pulled** so test 03 doesn't sit waiting for a
   10-minute first-time download:
   ```bash
   ollama pull qwen3-embedding:0.6b
   ```
5. **`curl`** required. **`jq`** optional but strongly recommended; the
   harness falls back to a `node` script and finally to `sed` if neither
   is available, but the fallback is coarser.

## Running

```bash
bash sideCar/test/chaos/run.sh                  # all 8 tests
bash sideCar/test/chaos/run.sh 03 05            # just 03 and 05
bash sideCar/test/chaos/run.sh --list           # list, don't run
```

### Environment overrides

| Variable           | Default                       | Purpose |
|--------------------|-------------------------------|---------|
| `SIDECAR_URL`      | `http://localhost:8098`       | sidecar base URL |
| `OLLAMA_HOST`      | `http://localhost:11434`      | native Ollama base URL |
| `MODEL`            | `qwen3-embedding:0.6b`        | embedding model for tests 03/05 |
| `EMBED_ROLE`       | `embedding`                   | role name (must match sidecar registry) |
| `COMPLETION_ROLE`  | `completion`                  | role name |
| `TEST_PULL_MODEL`  | `qwen2:0.5b`                  | small model used in test 02 (pull/kill) |
| `OOB_MODEL`        | `qwen2:0.5b`                  | model side-loaded in test 04 |

## Test catalogue

| # | Name                              | Pre-condition                | Asserts |
|---|-----------------------------------|------------------------------|---------|
| 01 | `ollama-down-at-boot`            | none                         | `hostOllama.lastHealth.error=='ollama_not_running'`; `/api/acquire` returns clean error; recovers within one tick |
| 02 | `ollama-killed-mid-pull`         | network access to pull model | `pullFailCount[role]` increments; retry pull succeeds |
| 03 | `ollama-killed-mid-embed`        | MODEL loaded                 | embed call errors; `activeRequests[role]` returns to 0 within 5s |
| 04 | `out-of-band-model-load`         | none                         | `vram.unattributedMb > 0` after side-load + reconcile tick |
| 05 | `out-of-band-model-evict`        | model loaded by sidecar      | `state.modelLoading` flag cleared; next acquire re-warms |
| 06 | `two-roles-idle-race`            | both roles host-routed       | stopping one role does NOT evict the other's model |
| 07 | `flag-flip-disable`              | sidecar running              | invariant: `hostOllama.enabled` matches role runtimes |
| 08 | `host-docker-internal-failure`   | sidecar running              | documents manual DNS-poisoning procedure (cannot automate) |

## Sample output (clean run)

```
==================================================================
 Chaos harness — host-Ollama failure modes
==================================================================
  sidecar: http://localhost:8098
  ollama:  http://localhost:11434
  model:   qwen3-embedding:0.6b
  tests:   8 of 8

------ 01-ollama-down-at-boot.sh ------
TEST 01/08: Ollama down at boot
  ✓ hostOllama.lastHealth.error classified as 'ollama_not_running' (after 16s; .hostOllama.lastHealth.error=ollama_not_running)
  ✓ /api/acquire returned HTTP 503 (not 500)
  ✓ /api/acquire body has .error field: host Ollama unreachable for role embedding (ollama_not_running)
  ✓ watchdog reports lastHealth.ok=true after recovery (after 12s; .hostOllama.lastHealth.ok=true)
RESULT: 01-ollama-down-at-boot — 4 checks passed

------ 02-ollama-killed-mid-pull.sh ------
TEST 02/08: Ollama killed mid-pull
  ✓ pullFailCount[embedding] incremented: 0 -> 1
  ✓ hostOllama back online after restart (after 14s; .hostOllama.lastHealth.ok=true)
  ✓ model 'qwen2:0.5b' present in /api/tags after retry (after 41s)
RESULT: 02-ollama-killed-mid-pull — 3 checks passed

... (etc) ...

==================================================================
 Summary
==================================================================
  passed:  8
  failed:  0
  elapsed: 412s
```

## Caveats discovered while building this

1. **Test 03 only triggers `activeRequests` decrement if `/api/acquire`
   and `/api/release` bracket the inference call.** The sidecar doesn't proxy
   inference (Ollama lives on the host; master calls it directly), so the
   counter only moves through the acquire/release lifecycle. The test
   simulates that bracket explicitly. If you're hunting an `activeRequests`
   leak in a real master, mirror this pattern.
2. **Test 07 cannot restart the sidecar from inside a script** that the
   sidecar is being polled by. It verifies the **current** invariant on
   either side of a flag flip; the operator does the restart manually
   between runs.
3. **Test 08 cannot poison `host.docker.internal` DNS from outside the
   container.** It prints the manual procedure and skips. If you're
   reproducing a real DNS regression, you have two options: set
   `SS_HOST_OLLAMA_HOST=nonexistent.invalid` and restart, or
   `docker exec sidecar sh -c 'sed -i "s/host.docker.internal/127.0.0.2/" /etc/hosts'`.
4. **VRAM accounting may be unsupported** on macOS without `nvidia-smi`.
   Test 04's `vram.unattributedMb` check downgrades to a warning rather than
   a failure when VRAM data is `null`.
5. **Two-role test (06) skips with a warning** if the sidecar is configured
   with only one host-routed role. It does NOT fail in that case.
6. **`prisma migrate dev` is never invoked** by this harness. No database
   touched.
7. **Each test is reentrant:** running the suite twice in a row leaves the
   system in the same state it found. Ollama is always restarted on EXIT
   via `CLEANUP_FN`/`trap`.

## Adding a new test

1. Create `NN-short-name.sh` next to the others.
2. Start with the boilerplate from any existing test:
   ```bash
   set -euo pipefail
   HERE=$(cd "$(dirname "$0")" && pwd)
   source "$HERE/lib.sh"
   echo "TEST NN/MM: Description"
   require_sidecar
   ```
3. Add it to the `ALL_TESTS` array in `run.sh`.
4. Update this README.
5. Verify syntax: `bash -n sideCar/test/chaos/NN-short-name.sh`.

## Syntax-checking everything

```bash
for f in sideCar/test/chaos/*.sh; do bash -n "$f" && echo "OK $f" || echo "BAD $f"; done
```
