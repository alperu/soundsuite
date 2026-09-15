# `ss-rlm-sandbox`

Run the **RLM pattern** — hold a context as a REPL variable, chunk/grep/recursively
sub-query it — against a hosted chat model, instead of self-hosting the
`mit-oasys/rlm-qwen3-8b-v0.1` fine-tune.

Two masters share one sandbox per host: **Sound Suite** (`legal`) and
**Fantom MCP** (`code`). Sound Suite's half is built. Fantom's is not.

| doc | for |
|---|---|
| [01-how-it-works.md](./01-how-it-works.md) | The architecture, every hop, and how to make a call |
| [02-fantom-integration.md](./02-fantom-integration.md) | **What Fantom must build**, file by file |
| [03-operations.md](./03-operations.md) | Build, publish, release, verify, troubleshoot |

---

## Status — 2026-09-16

Verified against the live fleet. Read this before trusting anything downstream.

### Working

| | evidence |
|---|---|
| Role assignable on every host | 4 hosts carry `ss-rlm-sandbox` with `runtime: docker-cpu` (sidecar ≥ 2.4.8) |
| Image published, multi-arch, public | `ghcr.io/project-sandstar/rlm-sandbox:0.1.1`, `linux/amd64` + `linux/arm64`, anonymous pull returns 200 |
| Container runs on all four hosts | `/health` 200; `/v1/models` lists the configured model |
| **Sidecar → OpenRouter** | Live call returned `pong` from `deepseek/deepseek-v4.1-flash` in 2.5 s, `usage.cost` = `$0.0000183` |
| Per-master key/model isolation | `GET` with `X-SoundSuite-Master` resolves Sound Suite's model; without it, 409 naming both masters |
| `max_budget` rail | `usage.cost` present on the live response — the field the `rlms` library reads |
| **FULL CHAIN** | master → `:8101` → sidecar → OpenRouter returned the needle from a 60-line haystack in **7 s** (sidecar 2.4.13, image 0.1.1) |

The end-to-end proof, reproducible:

```bash
curl -s -X POST http://<sidecar-host>:8101/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -H 'X-SoundSuite-Master: http://<your-master>:3000' \
  -d '{"messages":[{"role":"user","content":"...SECRET=418293..."}],"max_tokens":256}'
# -> 200 {"choices":[{"message":{"content":"418293"}}]}
```

### Known defect

**`usage` comes back zeroed** — `{"prompt_tokens":0,"completion_tokens":0,"total_tokens":0,"cost":null}`.
The numbers are real inside the container (the library tracks them, and
`max_budget` reads cost straight off the upstream response), but
`openai_response()` in `server.py` does not map `usage_summary` onto the
OpenAI-shaped reply correctly. Consequence: the **master cannot see sandbox
spend or token counts**. Cost control inside the loop is unaffected; reporting
is. Fix belongs in `docker/rlm-sandbox/server.py:openai_response()`.

### Not built at all

- **Retrieval tools.** `custom_tools` is stubbed. The loop reasons over the
  prompt it is handed; it cannot retrieve. Neither master exposes its tools over
  HTTP yet — that is the bulk of [02-fantom-integration.md](./02-fantom-integration.md).
- **Fantom's `domain: 'code'` declaration.**
- **Evaluation** of the pattern against the self-hosted fine-tune.

---

## Why this exists

`ss-rlm` runs a model **no SaaS provider serves** — zero inference providers on
Hugging Face, absent from OpenRouter. It is one of two roles that must be
self-hosted.

But RLM is an *inference strategy, not a weight*: it replaces
`llm.completion(prompt, model)` with `rlm.completion(prompt, model)`, where the
context lives in a REPL the model programmatically chunks and recursively
queries. The reference implementation drives ordinary API models.

So the pattern can run against models already being paid for — which drops the
must-self-host list from two roles to one, and lets a GPU-less Mac host it.

It does **not** replace `ss-rlm`. Both run until the pattern is measured against
the fine-tune.

## Source of truth

- Library: [`alexzhang13/rlm`](https://github.com/alexzhang13/rlm) @ `854e688f`,
  MIT — vendored at [`public/rlm/`](../../public/rlm/), 92 KB, served from any
  master. Distribution is **`rlms`**; the importable module is `rlm`.
- Paper: [arXiv 2512.24601](https://arxiv.org/abs/2512.24601) (Zhang, Kraska, Khattab)
- Contract: [`../SPEC-ss-rlm-sandbox.md`](../SPEC-ss-rlm-sandbox.md) — §4 security constraints are non-negotiable
- Runtime design: [`../DESIGN-ss-rlm-sandbox-runtime.md`](../DESIGN-ss-rlm-sandbox-runtime.md)
- Why the role was unassignable until 2.4.8: [`../tasks/50-rlm-sandbox-unassignable.md`](../tasks/50-rlm-sandbox-unassignable.md)
