# RLM Endpoint — How It Works & 2026-06-08 Changes

The **RLM (Recursive Language Model)** endpoint is the `ss-rlm` vLLM container that
powers Deep Search *synthesis*. This doc explains how it serves requests today and
the changes made on 2026-06-08 to fix a tool-use loop, correct the context window,
fix tool-call parsing, and pin the image.

---

## What it is

- **Model:** `mit-oasys/rlm-qwen3-8b-v0.1` — a Qwen3-8B post-trained for recursive,
  long-context legal reasoning.
- **Server:** Docker vLLM (`vllm/vllm-openai`) on a **dedicated** Linux + NVIDIA
  sidecar (48 GB A6000). Listens on **`:8100`**, OpenAI-compatible API.
- **Role/mode:** `ss-rlm` (see `src/lib/gpu/mode-catalog.ts`). Linux / Windows-WSL2
  only — Mac is excluded (no MLX conversion of the weights for vllm-metal).
- **Caller:** the master's Deep Search runs final synthesis through it via
  `runRlmWithTools()` in `src/lib/ai/stream-rlm.ts`, invoked from
  `src/lib/search/deep-search.ts`.

## Request flow (Phase B — recursive RAG)

1. Deep Search retrieves + reranks an initial set of excerpts (the **seed**).
2. The master opens a chat-completions call to the RLM with `tool_choice="auto"`
   and two tools: `query_case_knowledge` (vector search) and `query_case_graph`
   (motion/person relationships).
3. The RLM is an **evidence-gatherer**: each round it may call a tool to fetch
   *additional* excerpts beyond the seed, up to **`maxRounds = 4`**. When it has
   enough it answers briefly ("done"). **On the final round the master sends
   `tool_choice:'none'`** so the model *must* emit a text answer instead of
   another tool call — the RLM tends to keep gathering and never self-terminate,
   which previously bailed at maxRounds and discarded all evidence.
   It does **not** write the report; the gathered sources flow to a separate
   cloud-LLM (Claude) synthesis stage that produces the final answer.
4. Each round the master:
   - estimates input tokens (`chars / 3.2`),
   - **clamps** `max_tokens` so `input + output + safety ≤ RLM_CONTEXT_TOKENS`,
   - **trims** old assistant+tool turns if still over budget (preserving the
     system + initial user turn),
   - parses the tool calls and runs them, feeding results back.

If the loop hits `maxRounds` without a final answer it bails with
`RLM tool-use loop exceeded maxRounds=4` → `RLM synthesis failed`.

---

## Current serving config

`sideCar/src/lib/mode-templates.ts` (`RLM_VLLM_ARGS`, runtime authority) **and**
`sideCar/src/lib/state.ts` (`vllmArgs`, default registry) — both must match:

```
mit-oasys/rlm-qwen3-8b-v0.1 --host 0.0.0.0 --port 8100
  --gpu-memory-utilization 0.90
  --max-model-len 40960
  --kv-cache-dtype fp8
  --dtype bfloat16
  --enable-auto-tool-choice
  --tool-call-parser qwen3_xml
```

Image is pinned via `VLLM_IMAGE` in `state.ts`: **`vllm/vllm-openai:v0.21.0`**.

| Flag | Value | Why |
|------|-------|-----|
| `--gpu-memory-utilization` | `0.90` | Hard VRAM ceiling. The card is **dedicated** to ss-rlm, so vLLM may take ~43 GB. Lower to `0.7` if you co-locate other GPU roles on the same card. |
| `--max-model-len` | `40960` | The model's **native ceiling** (`max_position_embeddings=40960`, no `rope_scaling`). vLLM refuses to start above this without YaRN. |
| `--kv-cache-dtype` | `fp8` | Halves per-token KV (≈72 KiB vs 144 KiB). One full 40960-token sequence ≈ **2.8 GB** KV. |
| `--dtype` | `bfloat16` | Matches the published weights (no AWQ build exists). |
| `--enable-auto-tool-choice` | — | Without it vLLM 400s on `tool_choice="auto"`. |
| `--tool-call-parser` | `qwen3_xml` | The model emits Qwen3-Coder-style XML (see below). |

The master-side counterpart `RLM_CONTEXT_TOKENS` in `stream-rlm.ts` is **40960** and
must equal the server's `--max-model-len`, or vLLM 400s on `input + max_tokens >
max_model_len`.

### VRAM budget (48 GB A6000, dedicated)

| Component | Size |
|---|---|
| Weights (bf16, 8.19 B) | ~16.4 GB |
| CUDA / activations / cudagraphs | ~2.5 GB |
| KV per token (fp8) | 72 KiB |
| KV for one full 40960 seq (fp8) | ~2.8 GB |
| **Working set at full context** | **~22 GB** |

The GPU is **not** the bottleneck at 40960 — the model's native window is. The free
headroom only becomes useful with a larger context (see *Going beyond 40960*).

---

## Changes made 2026-06-08

### 1. Fixed the `maxRounds` loop (the real fix) — `deep-search.ts`

**Symptom:** `RLM synthesis failed: RLM tool-use loop exceeded maxRounds=4`.

**Root cause (from `logs/dashboard.log`):** the initial prompt was ~31.7 K tokens —
97 % of the old 32 K window. The seed `contextBlock` was capped at 60 K chars
(~18 K tokens) with **uncapped per-excerpt length**. Each retrieved tool result
overflowed the window, so `trimHistoryToFit` (which preserves system + initial
user, drops tool results) trimmed away the very excerpts the model just fetched.
With no memory of them, the model **re-issued the identical query every round** and
never synthesized.

**Fix:** in the RLM seed builder, lower the total to **30 K chars** and cap each
excerpt at **1500 chars** so the recursive fetches + final answer have room. This
breaks the loop even at a 32 K window.

### 2. Context window 32 K → 40 K — `mode-templates.ts`, `state.ts`, `stream-rlm.ts`

`--max-model-len 32768 → 40960` (the model's native max; +25 %) and added
`--kv-cache-dtype fp8`. `RLM_CONTEXT_TOKENS` bumped to 40960 to match. *(An
intermediate commit tried 65536 — that's invalid: it exceeds
`max_position_embeddings=40960` with no rope scaling and vLLM won't boot. Corrected
to 40960.)*

### 3. `--gpu-memory-utilization 0.7 → 0.90` — dedicated card

ss-rlm runs on a dedicated 48 GB A6000, so the old `0.7` cap (which existed to
protect co-located embedding/ocr) was relaxed. Revert to `0.7` if you ever share
the card.

### 4. Tool-call parser `pythonic → qwen3_xml` — the parser fix

The logs showed `vllm_tool_calls=0 … fallback parser fired … Parser config likely
mismatched`. The model actually emits **Qwen3-Coder-style XML**:

```
<tool_call><function=query_case_knowledge><parameter=query>…</parameter></function></tool_call>
```

Per the vLLM docs that's the **`qwen3_xml`** parser — *not* `pythonic`
(`name("…")`) nor `hermes` (JSON), both of which miss every call. vLLM 0.21.0
supports `qwen3_xml` (verified against its docs). `stream-rlm.ts` keeps a regex
fallback (`qwenXmlRe`) as a safety net if a served vLLM ever predates the parser —
the fallback handles a parser *mismatch* but not a non-starting server.

### 5. Pinned the vLLM image — `state.ts`

The ContainerDefs used `image: 'vllm/vllm-openai'` (untagged → `docker.ts`
`normalizeImageTag` resolves to `:latest`), so a fresh pull could silently change
vLLM versions and drop/alter the parser. Introduced a single `VLLM_IMAGE` constant
pinned to **`vllm/vllm-openai:v0.21.0`** — the version **already running** on the
host (confirmed via `/version`), so the recreate finds the layers cached (no
multi-GB re-pull) while still applying the new args. Bumping to a newer release
later **will** trigger a full image pull.

### 6. Force a final answer on the last round — `stream-rlm.ts`

End-to-end verification (Deep Search via `/api/search/deep` `useRlm`) showed
fixes 1–4 work — the RLM now issues **distinct, progressive** tool queries
("grounds" → "relief" → …) instead of the old identical-query amnesia loop. But
it still hit `maxRounds`: this evidence-gatherer never self-terminates — it emits
a fresh tool call every round and never a final "done", so the loop errored out
and discarded all gathered evidence before the synthesis stage. Fix: on the
**final round** send `tool_choice:'none'` so the model must produce a text answer
(and skip the regex fallback on that round so its text isn't re-read as a tool
call). The loop ends cleanly and synthesis proceeds with all gathered sources.

### Files touched

- `src/lib/search/deep-search.ts` — seed cap (fix 1) + comment.
- `src/lib/ai/stream-rlm.ts` — `RLM_CONTEXT_TOKENS = 40960` (fix 2) + last-round `tool_choice:'none'` (fix 6).
- `src/lib/ai/__tests__/stream-rlm-budget.test.ts` — derive test input from the constant.
- `sideCar/src/lib/mode-templates.ts` — `RLM_VLLM_ARGS`, `VLLM_IMAGE` use.
- `sideCar/src/lib/state.ts` — `vllmArgs`, `VLLM_IMAGE` constant.

---

## How a change reaches the running endpoint

The vLLM args come from the **sidecar** code (`resolveMode` in `mode-templates.ts`),
not the master, so a config change must ship in a new sidecar build:

1. `rm -rf sideCar/.next && ./scripts/buildSidecar.sh patch` — builds a versioned
   tarball into `public/sideCar/builds/` and updates `manifest.json`.
2. The master serves the manifest; each sidecar **auto-updates on its next
   heartbeat**, downloads the tarball, and restarts itself on the new version.
3. On reconcile the sidecar **detects config drift** (`handlers.ts:81`,
   `containers.ts:187` — *"Config drift detected … removing and recreating"*) and
   recreates `ss-rlm`: `removeContainer → pullImage(def.image) → createContainer`.
   - With the image pinned to the **running** version, `pullImage` is near-instant
     (layers cached); a *version* bump would download the new image.
   - The 16 GB model weights load from vLLM's HuggingFace cache on start — that's
     the bulk of the recreate downtime (~1–3 min), not the image pull.

A 2026-06-08 deploy went `2.3.66 → 2.3.68`; `ss-rlm` exited and came back **running**
within ~15 s of the recreate on `v0.21.0` with the new args.

---

## Going beyond 40960 (optional — YaRN)

The model is capped at 40960 tokens natively. To use more of the dedicated VRAM for
a bigger window, enable YaRN rope scaling:

```
'--rope-scaling', '{"rope_type":"yarn","factor":3.2,"original_max_position_embeddings":40960}',
'--max-model-len', '131072',
```

(and bump `RLM_CONTEXT_TOKENS` to match). 128 K fits easily — one fp8 sequence ≈
9 GB KV. **Not recommended by default:** YaRN mildly degrades short-context quality,
and the current recursive pipeline only uses ~15–20 K tokens (capped seed + tool
fetches), so even 40960 is already 2× more than it needs. Only worth it if you
change the flow to feed whole documents up front instead of fetching recursively.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| `RLM tool-use loop exceeded maxRounds=4` | Seed too large for the window (fix 1). Check `initialPromptChars` in `logs/dashboard.log`. |
| vLLM 400 on `prompt_tokens + max_tokens > max_model_len` | `RLM_CONTEXT_TOKENS` ≠ server `--max-model-len`. |
| Container won't start, `invalid tool-call-parser` | Served vLLM predates `qwen3_xml` — pin a newer image (regex fallback still works under `pythonic`). |
| `vllm_tool_calls=0 … fallback parser fired` | Parser mismatch — should be gone now with `qwen3_xml`; the fallback rescues it regardless. |
| ss-rlm `running` but endpoint not answering | vLLM still loading weights + allocating KV after a recreate (~1–3 min). |
