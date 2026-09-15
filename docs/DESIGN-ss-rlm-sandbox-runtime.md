# `ss-rlm-sandbox` — runtime design

**Status:** Design agreed, implementation in progress · **Created:** 2026-09-15
**Supersedes on points of conflict:** the 2026-09-15 design note ("run the RLM
pattern instead of hosting an RLM model") and [`SPEC-ss-rlm-sandbox.md`](./SPEC-ss-rlm-sandbox.md) §3
**Depends on:** [task 50](./tasks/50-rlm-sandbox-unassignable.md) (shipped in sidecar 2.4.8)

This document exists because the two prior documents were written *before anyone
read the library's source*. Six of their load-bearing claims turn out to be
wrong or stale. Where this file and those conflict, this one was checked against
`alexzhang13/rlm@854e688f`, vendored at [`public/rlm/`](../public/rlm/).

---

## 1. Corrections to the prior documents

| claim | reality | where it came from |
|---|---|---|
| "the `rlm` library", not on PyPI | Distribution is **`rlms`**; the *module* is `rlm`. It **is** on PyPI. | `pyproject.toml:name` |
| Tools must be passed as **Python code strings** — host callables cannot cross the process boundary | True only for **isolated** environments. `custom_tools` takes **callables**; with `environment="local"` they stay in-process. | `RLM.__init__` docstring |
| Use `DockerREPL` (`environment="docker"`) | Cannot: it shells out to the `docker` CLI, which needs the socket. Spec §4 forbids the socket in the sandbox, and the sidecar never passes it (`docker.ts:927-934`). | see §3 |
| `docker build -f Dockerfile.sandbox` | **No such file upstream.** The docstring in `docker_repl.py` references a file that does not exist in the repo. | verified at `854e688f` |
| Role is `type: 'utility'` | `type: 'vllm'`. Utility roles are skipped by `ensureContainerForRole()`. | already corrected in SPEC §6 |
| OpenRouter is a cost-tracking *backend* | There is no OpenRouter client. Backends are `openai`, `anthropic`, `gemini`, `azure_openai`, `portkey`. OpenRouter is reached as `openai` + `base_url`. | `rlm/clients/` |

The last one has a consequence, in §5.

---

## 2. Architecture

```
                   ┌─ CONTROL PLANE ─────────────────────────────┐
                   │  pull / start / stop, lease, idle timer      │
  master :3000 ────┤                                             │
    │  /config     │   SIDECAR :8098                             │
    │              │   · per-master OpenRouter key               │
    │              │   · allowedModels['rlm-sandbox']            │
    │              │        │ docker run (runtime: docker-cpu)   │
    │              │        ▼                                    │
    │  DATA PLANE  │   ╔══════════════════════════════════════╗  │
    └──────────────────▶║ ss-rlm-sandbox              :8101    ║  │
   resolveRlmEndpoint() ║  server.py  — OpenAI-compatible shim ║  │
   POST /v1/chat/…      ║     │                                ║  │
                        ║     ▼                                ║  │
                        ║  RLM(environment="local")            ║  │
                        ║   model-written Python, in-process    ║  │
                        ║     │                     │           ║  │
                        ╚═════│═════════════════════│═══════════╝  │
                              │ llm_query           │ custom_tools │
                              │ rlm_query           │ (callables)  │
                              ▼                     ▼              │
                    sidecar /v1/chat/completions   master HTTP     │
                        (NEW — §4)                  (stubbed, §7)  │
                              │                                    │
                              ▼                                    │
                        OpenRouter — deepseek/deepseek-v4-flash    │
                                                                   │
  KEY LIVES HERE ──────────────────────────────────────────────────┘
  (sidecar, per master — never in the container)
```

The sidecar is **control plane only**. It creates the container and manages its
lease, but the master's inference call goes **straight to `:8101`** —
`resolveRlmEndpoint()` returns `http://<sidecar-host>:8101` and dials it
directly. Same shape as the Docker Model Runner path.

---

## 3. Decision: `environment="local"`, not `"docker"`

The design note's central recommendation was to use the library's own
`DockerREPL`, on the strength of its docs: *"The container runs fully isolated
from the host; a lightweight host-side proxy bridges LM access back into the
container."* That is genuinely elegant — **for the topology the note assumed**,
where the `rlm` library runs *on the host*.

What shipped is a different topology: the library runs **inside** a
sidecar-managed role container. In that position `DockerREPL` means *nested*
Docker — our container would have to spawn its own children, which requires
`/var/run/docker.sock` inside it. That is the one thing spec §4 calls
non-negotiable, and it is not a theoretical objection: role containers get only
`ollama-models` or `huggingface-cache` binds (`sideCar/src/lib/docker.ts:927-934`).
There is no socket to use.

So: **the container is the isolation boundary**, and the REPL runs in-process
inside it. That is spec §4's own stated reasoning — "container isolation is
considered sufficient" — merely applied one layer out from where the note put it.

Nothing is lost. `llm_query`, `rlm_query`, `custom_tools`, `persistent=True`,
`compaction=True` and the recursion controls are the `RLM` class's API, not
`DockerREPL`'s. One thing is *gained*: with `local`, `custom_tools` accepts
ordinary Python callables, so the retrieval tools are functions rather than
injected code strings.

**If the threat model changes**, `environment="e2b"` / `"modal"` remains a
one-line swap — those are hosted microVMs and need no local socket. That escape
hatch is intact; only the `docker` value is unavailable to us.

---

## 4. New component: `virtual-chat` on the sidecar

**This is the piece that does not exist, and everything else depends on it.**

Today the sidecar's virtual-inference surface is three **WebSocket** actions —
`virtual-embed`, `virtual-rerank`, `virtual-key-info` (`ws-client.ts:374-376`) —
all invoked *by a master, over that master's socket*. There is no `virtual-chat`,
and no HTTP route for any of them. The sandbox needs the opposite direction:
container → sidecar → OpenRouter.

**Route:** `sideCar/src/app/api/v1/chat/completions/route.ts`

OpenAI-compatible, so the container configures
`RLM(backend="openai", backend_kwargs={"base_url": "http://<sidecar>:8098/v1", "api_key": "<scoped>"})`
and the library needs no OpenRouter awareness at all.

It reuses what already works: `openrouter-client.ts` for the call, and
`virtual-inference.ts:221` for per-master `apiKey` + `allowedModels` resolution.

### 4.1 Which master's key? — decided

The existing `virtual-*` actions get `m.serverUrl` for free because they arrive
over that master's WebSocket. An HTTP route has no such context, and the key,
the model and the spend are all **per master** by design so Sound Suite and
Fantom cannot clobber each other.

**v1 resolves to the single configured master, and fails loudly with 409 when
more than one is configured.** Not "pick the first" — that silently spends one
master's budget on the other's model, and Fantom's half of the contract is not
started, so one master is the real state today rather than a simplification.

When Fantom lands, the master threads its own identity: `resolveRlmEndpoint()`
already returns a struct the master controls, so the master sends its
`serverUrl` when it dials `:8101`, and `server.py` forwards it as a header. That
is a small additive change, and the 409 is what will force it to happen rather
than be forgotten.

---

## 5. Safety rails — and one that is inert

`RLM.__init__` ships the limits spec §4 asked for:

| parameter | setting | why |
|---|---|---|
| `max_timeout` | **yes** | "Model-written loops do not reliably terminate." The primary rail. |
| `max_tokens` | **yes** | Total input+output ceiling. |
| `max_errors` | **yes** | Stops a loop erroring in circles. |
| `max_iterations` | default 30 | Root-loop bound. |
| `max_concurrent_subcalls` | 4 (default) | An RLM fans out; this bounds the burst. |
| `max_budget` | **works — conditionally** | See below. |

**Corrected after reading the source.** An earlier draft of this document
asserted `max_budget` was inert through our proxy, reasoning from its docstring
(*"Requires cost-tracking backend (e.g. OpenRouter)"*) that a generic `openai`
backend would lose it. That was wrong. `rlm/clients/openai.py:_track_cost` reads
`usage.cost` off the response and is **not** gated on `base_url` — it only
checks whether the field is present.

So the rail is live, on two conditions, both of which the implementation meets:

1. The route asks OpenRouter for cost — `chat()` sends `usage: {include: true}`,
   without which the field is absent.
2. The route returns the upstream response **verbatim**. This is why
   `openrouter-client.chat()` does not reshape, unlike `embed()`/`rerank()`.

**If either is undone, `max_budget` silently becomes a no-op** on a role that
makes many sub-calls per question. That is the failure the earlier draft
imagined, and it is one careless refactor away — hence the comments at both
sites and the gated integration test that asserts `usage.cost` is a number.

---

## 6. The image

```dockerfile
FROM python:3.11-slim
ARG MASTER_URL
ARG RLMS_SHA256
# Vendored from the master, not PyPI/GitHub: the build host may have a route to
# a master and nothing else. Checksum-verified, same discipline as install.sh.
ADD ${MASTER_URL}/rlm/rlms-latest.tar.gz /tmp/rlms.tar.gz
RUN echo "${RLMS_SHA256}  /tmp/rlms.tar.gz" | sha256sum -c - \
 && mkdir -p /tmp/rlms && tar xzf /tmp/rlms.tar.gz -C /tmp/rlms \
 && pip install --no-cache-dir /tmp/rlms && rm -rf /tmp/rlms*
COPY server.py /app/server.py
USER nobody
EXPOSE 8101
CMD ["python", "/app/server.py"]
```

`server.py` is the only code we write — roughly 100 lines:

1. Serve `POST /v1/chat/completions` on 8101 (what the master dials) and
   `GET /health`.
2. Construct `RLM(...)` with `backend="openai"`, `backend_kwargs` pointing at the
   sidecar route, `environment="local"`, the §5 rails, and `custom_tools`.
3. Return an OpenAI-shaped response.

Registry entry is already correct and needs no change: `port: 8101`, `vram: 0`,
`type: 'vllm'`, `requiresGpu: false`, runtime `docker-cpu`
(`sideCar/src/lib/state.ts:220`, `mode-templates.ts:rlmSandboxDef`).

**Registry: `ghcr.io/project-sandstar/rlm-sandbox`**, published 2026-09-15.

Docker Hub `soundsuite/` was chosen first, on the reasoning that keeping the
existing name avoided a code change. It was abandoned for a practical reason,
not a principled one: the org 404s (so it does not exist), and `docker login` is
interactive — it cannot be driven from a non-TTY session. GHCR was reachable
immediately because `gh` was already authenticated; it needed only
`gh auth refresh -s write:packages`, after which
`gh auth token | docker login ghcr.io -u <user> --password-stdin` is fully
non-interactive.

The image name therefore changed, which means **both** `state.ts:defaultRegistry
['rlm-sandbox'].image` and `mode-templates.ts:rlmSandboxDef()` — the
registry-overwrite trap, where editing only `defaultRegistry` is silently
dropped at runtime because the master's `/config` push replaces
`state.registry[role]` wholesale. A test now pins the two together.

**Pinned to `:0.1.0`, not `:latest`.** `pullImage` (`docker.ts:1139`) inspects
locally and skips the pull when the image is already present, so `:latest` would
freeze every host on whatever it first pulled, with no way to tell which build
that was — an unpinned tag that behaves like a pinned one, differently per host.
Same reasoning as `VLLM_IMAGE`. Bumping the image is therefore a sidecar
release, deliberately.

**GHCR packages are private by default**, and the sidecars hold no registry
credentials. The package must be made public or every host needs a credential
and a rotation story. GitHub exposes **no REST endpoint** for this — `PATCH
/orgs/{org}/packages/container/{name}` returns 404 — so it is a one-time manual
step at
`https://github.com/orgs/Project-SandStar/packages/container/package/rlm-sandbox`
→ Package settings → Danger Zone → Change visibility.

A private package fails the pull with a 401, which surfaces as a container that
will not start — indistinguishable at a glance from the image not existing.

### 6.1 The image MUST be multi-arch

The fleet is mixed, verified live on 2026-09-15 — all five hosts on sidecar
2.4.8:

| host | `host.os` | GPU | arch |
|---|---|---|---|
| `10.10.20.5` | windows-docker-wsl2 | RTX A6000 | amd64 |
| `10.10.20.6` | windows-docker-wsl2 | RTX A6000 | amd64 |
| `10.10.20.134` | windows-docker-wsl2 | TITAN RTX | amd64 |
| `192.168.88.249` | mac-docker-ollama | — | arm64 |
| `192.168.88.238` | mac-docker-ollama | — | arm64 |

A single-arch image fails on whichever half it was not built for, with
`exec format error` — and the failure surfaces as a container that will not
start, not as a pull error, so it reads like a bug in this role rather than a
packaging mistake.

Build with a `docker-container` buildx driver; the default `docker` driver
cannot export a manifest list:

```bash
docker buildx create --name ssmulti --driver docker-container --use   # once
docker buildx build --builder ssmulti \
  --platform linux/amd64,linux/arm64 \
  --build-arg MASTER_URL=http://<master>:3000 \
  --build-arg RLMS_SHA256=$(node -p "require('./public/rlm/manifest.json').sha256") \
  -t ghcr.io/project-sandstar/rlm-sandbox:0.1.0 \
  --push docker/rlm-sandbox
```

Verify the manifest list really carries both before trusting it —
`docker buildx imagetools inspect ghcr.io/project-sandstar/rlm-sandbox:0.1.0` must list
`linux/amd64` **and** `linux/arm64`. (Two `unknown/unknown` entries alongside
them are buildx attestation manifests and are expected.)

Note the two Macs are the hosts that could not run this role at all before the
`docker-cpu` runtime shipped in 2.4.8 — they are the reason the multi-arch
requirement exists.

---

## 7. Explicitly not in this pass

- **Master-side HTTP tool endpoints.** `query_case_knowledge` / `query_case_graph`
  are not exposed over HTTP, so `custom_tools` is **stubbed**. The sandbox will
  run its loop and reason over the prompt it is given; it cannot yet retrieve.
  That is enough to prove the image, the contract and the routing, and it keeps
  this pass out of the master's MCP surface.
- **Fantom's half** — `domain: 'code'`, `search_code` / `search_symbols` /
  `search_files`. Not started, not ours.
- **`RLM_CONTEXT_TOKENS`**, which clamps to 40,960 (`ss-rlm`'s vLLM ceiling) even
  on the sandbox path where the hosted model advertises ~1.05 M. Being addressed
  separately; see `stream-rlm.ts`.
- **Evaluating the pattern against the fine-tune.** Spec §6's open question
  stands: do not retire `ss-rlm` on the strength of a design document.

---

## 8. Verification

Deliberately bottom-up — each step is provable before the next exists, so a
failure is never debugged through two layers of container.

### Done

| # | check | result |
|---|---|---|
| 1 | Vendored tarball is fetchable from a running master and its sha256 matches the manifest | ✅ `200 application/gzip`, 93,842 bytes, sha matches |
| 2 | Route refuses rather than guesses whose key to spend | ✅ 8 tests, incl. 409-on-two-masters naming both |
| 3 | Image builds fetching only from a master — no GitHub, no PyPI | ✅ |
| 4 | Checksum verification **fails closed** on a wrong sha | ✅ `sha256sum: WARNING: 1 computed checksum did NOT match`, no image produced |
| 5 | Container boots and serves | ✅ `/health` and `/v1/models` both 200 |
| 6 | `/admin/openrouter` can no longer blank the sandbox model | ✅ 6 tests; mutation-checked (4 fail against the old guard) |
| 7 | Image published, multi-arch, anonymously pullable | ✅ `ghcr.io/project-sandstar/rlm-sandbox:0.1.0`, `linux/amd64` + `linux/arm64`, 200 on an anonymous manifest fetch |
| 8 | Container actually boots on a fleet host | ✅ 2026-09-16 on a Mac sidecar — boot banner, `/health` 200 |

### Two defects the fleet found that no test could have

Both were invisible until a container really ran, and both came from the same
root: **`type: 'vllm'` is a lie told for the container lifecycle**, and nobody
traced what else reads it.

**1. The sidecar handed the image a vLLM command line.** `createContainer` keys
`buildVllmCmd(def.model, ...)` off `def.type === 'vllm'`, producing
`[model, '--host', ...]` — the model id as argv[0]. Right for
`vllm/vllm-openai`, whose ENTRYPOINT is `vllm serve`; fatal for any other image.
Every host died instantly with

```
[FATAL tini (7)] exec deepseek/deepseek-v4-flash failed: No such file or directory
```

Fixed by `ContainerDef.usesImageCmd` (2.4.10). Note the symptom reads as a
broken *image*, not as a command the sidecar invented — which is why the
container logs, not the pull path, were where the answer was.

**2. The fix did not reach three hosts, because containers are immutable.** A
container keeps the Cmd it was created with for life; pulling a corrected image
changes nothing. With `RestartPolicy: unless-stopped` the stale ones looped
forever. `ensureContainerForRole` *does* remove and recreate on drift
(`containers.ts:191`) and checks whenever the container exists regardless of
status — but the Cmd comparison was gated on `expected.Cmd` being truthy, so for
a `usesImageCmd` role "I expect no Cmd" was indistinguishable from "I have no
expectation" and the check was skipped. Fixed by `ExpectedConfig.ExpectsNoCmd`
(2.4.11), so no operator has to SSH in and `docker rm`.

The general lesson, worth keeping: **a drift check that only fires when it
expects *something* cannot detect a leftover.** `buildExpectedConfig` also held
a second copy of the vLLM Cmd builder, which had to be gated too or drift would
be computed against a config that would never be created.

### Not done — and what each needs

| # | check | blocked on |
|---|---|---|
| 7 | Route returns a **real** completion, and `usage.cost` is a number | A real OpenRouter key. Gated integration test exists: `OPENROUTER_TEST_KEY=sk-or-… npx jest virtual-chat-openrouter` from `sideCar/`. This is the only check that proves `max_budget` works. |
| 8 | Container completes an end-to-end RLM run through the route | (7), plus a sidecar with the model configured |
| 9 | Sidecar starts it from a role assignment — row goes *not provisioned* → *running*, `/api/status` shows `config.port: 8101` | image published to a registry (§6 open question) |
| 10 | Master routes to it: `virtualInference.mode.rlm = 'local-first'`, no `ss-rlm` anywhere, `notice` event fires | 7–9, and a non-empty `rlm.sandboxModel` |

Only (10) proves the feature. 1–6 are what make it debuggable; 7 is the next
step and needs nothing but a key.

**Live blocker for (10):** `rlmSandboxModel` was observed **empty** on this
master on 2026-09-15 — almost certainly wiped by the save bug fixed in (6).
`resolveRlmEndpoint()` skips the sandbox fallback entirely when it is unset, so
it must be set on `/admin/openrouter` before any of this routes.

---

## 9. References

- [`SPEC-ss-rlm-sandbox.md`](./SPEC-ss-rlm-sandbox.md) — two-master contract; §4 security constraints stand unchanged
- [`tasks/50-rlm-sandbox-unassignable.md`](./tasks/50-rlm-sandbox-unassignable.md) — why the role could not be assigned until 2.4.8
- [`public/rlm/`](../public/rlm/) — the vendored library, pinned at `854e688f`
- `sideCar/src/lib/state.ts:179-243` — registry entry and its reasoning
- `src/lib/ai/stream-rlm.ts:307-342` — the fallback that dials `:8101`
- [arXiv 2512.24601](https://arxiv.org/abs/2512.24601) — Zhang, Kraska, Khattab
