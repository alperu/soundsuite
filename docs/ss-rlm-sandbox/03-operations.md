# `ss-rlm-sandbox` — operations

Build, publish, release, verify, troubleshoot.

---

## 1. Turning it on

Three settings, all required. Miss any one and it fails in a different place.

| # | where | setting | if missing |
|---|---|---|---|
| 1 | `/admin/roleassign` | `ss-rlm-sandbox` → **Docker (no GPU)** on a host | no container at all |
| 2 | `/admin/openrouter` | **RLM Sandbox fallback** = a tools+reasoning model | sidecar 503s; `resolveRlmEndpoint()` skips the fallback entirely |
| 3 | `/admin/openrouter` | **RLM fallback mode** = `local-first` | master never routes to it (default `local-only`) |

(2) is the one that hides: with it blank the role looks healthy — container
running, `/health` 200 — and the master silently never routes there, logging
only `sandbox fallback skipped — no rlm.sandboxModel configured`.

Current value on this fleet: `deepseek/deepseek-v4.1-flash`. Note the spec's
nominal default `deepseek/deepseek-v4-flash` (no `.1`) **is not in the live
OpenRouter catalogue** — it would 404 if ever used.

---

## 2. Rebuilding the image

Needed when `server.py` or the Dockerfile changes.

```bash
# once per machine — the default docker driver cannot export a manifest list
docker buildx create --name ssmulti --driver docker-container --use

gh auth refresh -s write:packages                       # once, if not already
gh auth token | docker login ghcr.io -u <user> --password-stdin

docker buildx build --builder ssmulti \
  --platform linux/amd64,linux/arm64 \
  --build-arg MASTER_URL=http://<master>:3000 \
  --build-arg RLMS_SHA256=$(node -p "require('./public/rlm/manifest.json').sha256") \
  -t ghcr.io/project-sandstar/rlm-sandbox:0.1.2 \
  -t ghcr.io/project-sandstar/rlm-sandbox:latest \
  --push docker/rlm-sandbox
```

**Multi-arch is mandatory** — the fleet is 3× amd64 (Windows/WSL2) and 2× arm64
(Mac). Verify:

```bash
docker buildx imagetools inspect ghcr.io/project-sandstar/rlm-sandbox:0.1.2
# must list linux/amd64 AND linux/arm64
# two extra unknown/unknown entries are buildx attestations — expected
```

Then bump the pin in **both** files — `state.ts` `defaultRegistry['rlm-sandbox']`
and `mode-templates.ts` `rlmSandboxDef()` — and cut a sidecar release. A test
asserts they agree; editing only `defaultRegistry` is silently dropped at
runtime because the master's `/config` push replaces `state.registry[role]`
wholesale.

**Pinned, never `:latest`.** `pullImage` (`docker.ts`) skips the pull when the
image is already present locally, so `:latest` freezes each host on whatever it
first pulled with no way to tell which build that was.

### Package visibility

GHCR packages are **private by default** and the sidecars hold no registry
credentials. GitHub exposes **no REST endpoint** for this —
`PATCH /orgs/{org}/packages/container/{name}` returns 404. It is a manual step:

`https://github.com/orgs/Project-SandStar/packages/container/package/rlm-sandbox`
→ Package settings → Danger Zone → Change visibility → Public

Verify anonymously, which is what a sidecar is:

```bash
TOKEN=$(curl -s "https://ghcr.io/token?scope=repository:project-sandstar/rlm-sandbox:pull&service=ghcr.io" | jq -r .token)
curl -s -o /dev/null -w '%{http_code}\n' -H "Authorization: Bearer $TOKEN" \
  -H 'Accept: application/vnd.oci.image.index.v1+json' \
  https://ghcr.io/v2/project-sandstar/rlm-sandbox/manifests/0.1.2
# 200 = pullable by the fleet
```

---

## 3. Re-vendoring the library

```bash
./scripts/vendorRlm.sh                # upstream HEAD
./scripts/vendorRlm.sh <commit-sha>   # pin a specific commit
```

Idempotent — refuses to rewrite when the commit is unchanged, and aborts if
upstream ever drops `LICENSE`. `public/` is served from disk at request time, so
a re-vendored tarball is live to build hosts immediately; no rebuild, no
restart. Commit `public/rlm/` — it is tracked on purpose (`public/sideCar/builds`
is not, and a backup that is not committed is not a backup).

---

## 4. Releasing the sidecar

```bash
./scripts/buildSidecar.sh patch
```

Verify the **staged artifact**, not the source:

```bash
SP=$(mktemp -d) && tar xzf public/sideCar/builds/sidecar-latest.tar.gz -C $SP
grep -c FORCE_DOCKER $SP/sidecar/start.sh                    # must be > 0
shasum -a 256 public/sideCar/builds/sidecar-latest.tar.gz    # must match manifest.json
grep -ro 'rlm-sandbox' $SP/sidecar/.next | wc -l             # your change, compiled
```

**Grep the bundle for string literals and route paths, never function names** —
identifiers are minified, so a zero hit proves nothing. `resolveSandboxMaster`
returned 0 matches in a build that definitely contained it.

Hosts auto-update on heartbeat — about **90 seconds** observed across this
fleet. Confirm with `/api/status` → `agent.version`.

---

## 5. Verifying end to end

Bottom-up, so a failure is never debugged through two layers.

```bash
H=http://<sidecar-host>:8098
M=http://<your-master>:3000

# 1. role resolved, container up
curl -s $H/api/status | jq '.containers["rlm-sandbox"]'
# exists:true, status:"running", config.port:8101

# 2. identity + model resolve
curl -s -H "X-SoundSuite-Master: $M" $H/api/v1/chat/completions
# 200 {"object":"list","data":[{"id":"deepseek/deepseek-v4.1-flash",...}]}

# 3. sidecar -> OpenRouter (real spend, fractions of a cent)
curl -s -X POST -H 'Content-Type: application/json' -H "X-SoundSuite-Master: $M" \
  -d '{"messages":[{"role":"user","content":"Reply with exactly: pong"}],"max_tokens":16}' \
  $H/api/v1/chat/completions | jq '.choices[0].message.content, .usage.cost'
# "pong"  and a non-null cost — cost is what max_budget reads

# 4. full chain through the container
curl -s -X POST -H 'Content-Type: application/json' -H "X-SoundSuite-Master: $M" \
  -d '{"messages":[{"role":"user","content":"...SECRET=418293 buried in filler..."}],"max_tokens":256}' \
  http://<sidecar-host>:8101/v1/chat/completions | jq '.choices[0].message.content'
# "418293" — observed in ~7s
```

Step 3 is the only one that proves `max_budget` works.

---

## 6. Troubleshooting

### `status: not_found`, nothing in logs

The image cannot be pulled. Check it exists **and is public** (§2). A private
package fails with a 401 that is indistinguishable from a missing image at the
sidecar.

### `status: restarting`, logs show `[FATAL tini] exec <model-id> failed`

A container created before sidecar 2.4.10, carrying a vLLM command line baked in
at creation. **Containers are immutable** — a corrected image does not change an
existing container's `Cmd`.

Sidecar ≥ 2.4.11 detects this and recreates automatically (observed: stuck →
running in ~90 s). If you are on an older sidecar, upgrade rather than
`docker rm` by hand — the whole point is that the sidecar owns this.

### `409 — N masters have OpenRouter keys`

Working as designed. Send `X-SoundSuite-Master` matching the `serverUrl` you
pushed. See [02-fantom-integration.md §3](./02-fantom-integration.md#3-identity--which-masters-key-gets-spent).

### `503 — has not configured a model for rlm-sandbox`

`rlmSandboxModel` is blank, or blank *for that master*. Set it on
`/admin/openrouter`. It is per master — one being set says nothing about the
other.

### Container runs, master never uses it

Check in order: `virtualInference.mode.rlm` is `local-first`; `rlm.sandboxModel`
is set; no sidecar has `ss-rlm` running (the sandbox is a *fallback* — the
self-hosted role wins). The master logs which branch it took.

### `usage` is zeroed on the response

Known defect. Real numbers exist inside the container and `max_budget` works;
`openai_response()` in `server.py` maps `usage_summary` wrongly, so the **master
cannot see sandbox spend**. Fix in `docker/rlm-sandbox/server.py`.

### Reading container logs

```bash
curl -s "http://<sidecar-host>:8098/api/logs?role=rlm-sandbox&tail=50" | jq -r .logs
```

No SSH needed. This is what found the `tini` crash after a long detour through
the pull path — **go here first** when a container is up but misbehaving.

---

## 7. Cost

`deepseek/deepseek-v4.1-flash`, ~1.05M context, tools + reasoning, 17 providers
(single-provider models were rejected — that exposure took two Qwen rerankers
dark).

A trivial call measured **$0.0000183**. An RLM makes many sub-calls per
question, so cost scales with loop depth and fan-out, not with one request. The
rails in [01-how-it-works.md §4](./01-how-it-works.md#safety-rails) bound it;
OpenRouter per-role daily caps are the backstop.
