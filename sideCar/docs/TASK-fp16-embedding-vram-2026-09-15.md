# Sidecar: make `vram` follow the model, before anyone selects fp16

Task, 2026-09-15. Blocks the fp16 embedding rollout.

## Why this is needed

Fantom measured local-vs-cloud cosine at **0.976** for what is nominally the
same model, against **0.9986** between two local hosts. Cause: Ollama serves
`qwen3-embedding:4b` as **Q4_K_M** while hosted providers run full precision.
4-bit rounding is exactly that size of error, so the two cannot share a vector
index — Fantom's compatibility gate refused all five cloud providers.

The fix is to run fp16 locally. Sound Suite's admin now offers those tags
(`5cecf4f5`, `ba628039`). **The sidecar is not ready for them.**

## Availability — confirmed, not assumed

Pulled from `registry.ollama.ai` on 2026-09-15:

| tag | download / weights |
|---|---|
| `qwen3-embedding:4b` (current) | **2.50 GB** |
| `qwen3-embedding:4b-q8_0` | **4.28 GB** |
| `qwen3-embedding:4b-fp16` | **8.05 GB** |
| `qwen3-embedding:0.6b-fp16` | **1.20 GB** |
| `qwen3-embedding:8b-fp16` | **15.14 GB** |

All resolve. They are ordinary library tags, so **Docker Ollama and macOS
host-ollama both pull them unchanged** — no image, runtime or API change is
needed. Compatibility is not the problem. Memory accounting is.

## The blocker

`mode-templates.ts` declares a **static** `vram` per role. Every
`ss-code-embedding` entry is `vram: 2000`, sized for the 2.5 GB Q4 build
(lines ~229, ~408, ~472).

`modelOverrides` lets the master push a different **model**, but nothing
recomputes **vram**. So selecting fp16 in the admin UI leaves the sidecar
believing an 8.05 GB model needs 2 GB. That number is not decorative:

- `eviction-planner.ts:66` — `want = def.vram + headroom`. Plans to free ~3 GB
  for a model needing ~9 GB, so it **under-evicts** and the load fails or the
  GPU thrashes.
- `handlers.ts:261` — `if (freeVram < def.vram * 0.5)` defers a load. At
  `vram: 2000` it will happily start an 8 GB load with **1 GB free**.
- `containers.ts:248` — `evictForRole()` logs and decides against the same
  figure.
- `vram-accountant.ts` uses `def.vram` as the static budget for planning.

On BASWS35 (24 GB TITAN RTX) this is recoverable. On the Macs, where unified
memory is shared and three models have been resident at once, it is not.

## What to build

1. **Derive `vram` from the resolved model, not the template.** The manifest
   already carries the weight size; Ollama's `/api/show` and `/api/tags` report
   it per installed model. Size the budget from the actual tag in force after
   `modelOverrides`, with the template value as a floor for when nothing is
   known yet.
2. **Failing that, let the master push a vram hint** alongside `modelOverrides`
   — Sound Suite knows which tag it selected and its size is in
   `CODE_EMBEDDING_MODELS`. Less good, because it re-introduces two places that
   must agree.
3. **Re-read the budget when the model changes.** A push that swaps Q4 for fp16
   must invalidate any cached sizing, or the first load after the change uses
   the old number.
4. **Refuse rather than thrash.** If the resolved model cannot fit the host's
   memory even after eviction, log a clear refusal naming both figures. A Mac
   asked for `8b-fp16` at 15.14 GB should say so, not retry three times and
   give up with "insufficient VRAM".

## Also worth fixing while here

`CODE_EMBED_MODEL` (`mode-templates.ts:40`) is still
`hf.co/jinaai/jina-code-embeddings-1.5b-GGUF:Q8_0` — the Jina model abandoned
on 2026-09-14 because Ollama ≥0.3x refuses it for want of `pooling_type`. The
master's override wins in practice, so this is only the fallback when no push
has happened, but that is exactly the fresh-install path.

## Deployment note

Changing precision **invalidates every existing vector** even though the width
is unchanged at 2560. Fantom plans a full re-index. Sequence the rollout so the
sidecar can size fp16 correctly *before* the model is selected, not after.

Expect local throughput to **drop**: embedding is prefill-bound and fp16 moves
4x the weight bytes of Q4. The point is not local speed, it is that fp16 vectors
can share an index with hosted providers, letting cloud capacity join the
fan-out at all.

## Verification

- Select `4b-fp16` in `/admin/embedding`, confirm the sidecar reports a budget
  near 8 GB rather than 2 GB.
- Confirm eviction frees enough on a loaded GPU instead of under-planning.
- Confirm a Mac refuses `8b-fp16` with a clear message naming 15.14 GB.
- Then re-run Fantom's `POST /admin/sidecars/virtual/verify`; the cosine should
  clear 0.99, where it currently reads 0.976.
