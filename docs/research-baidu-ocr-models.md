# Research: Baidu OCR Models for Sound Suite (Unlimited-OCR & PaddleOCR-VL)

**Date:** 2026-08-05
**Constraint:** no Python in the app stack — models must be reachable over HTTP (Ollama / vLLM / llama-server / Docker Model Runner), which fits Sound Suite's existing `ocr` GPU role and sidecar runtimes.

## Verification

Both projects are **real** (claims independently verified against primary sources):

| | Unlimited-OCR | PaddleOCR-VL-1.6 |
|---|---|---|
| Org | Baidu | PaddlePaddle (Baidu) |
| Paper | arXiv 2606.23050 (Jun 2026) | arXiv 2606.03264 (1.5/1.6); 2510.14528 (0.9B) |
| Params | 3.34B BF16 (~6.7 GB), MoE (`num_experts_per_tok: 6`) | 0.96B BF16 (~1.9 GB) |
| License | **MIT** | **Apache-2.0** |
| Lineage | Built on DeepSeek-OCR (`modeling_deepseekv2.py`) | PaddleOCR family; 1.6 supersedes 0.9B and 1.5 |

Unlimited-OCR's differentiator: **Reference Sliding Window Attention (R-SWA)** — each token attends to all reference tokens (visual + prompt) plus the preceding 128 output tokens, giving a **constant KV cache** across the whole decode. Max length 32K; the paper claims dozens of pages transcribed in a single forward pass (`<image>Multi page parsing.` with an array of page images). The widely-quoted "0.5B active params" figure came from secondary press and could **not** be confirmed from the model card/config.

## Capability matrix for court PDFs

| | Unlimited-OCR (3B) | PaddleOCR-VL-1.6 (0.9B) |
|---|---|---|
| Scanned-page OCR | Yes | Yes |
| Multi-page single pass | **Yes** (flat KV cache) | No — page at a time |
| Tables | Yes (unified markdown output) | Yes, dedicated `Table Recognition:` prompt |
| Formulas | Yes | Yes |
| Charts | Not separately documented | Yes |
| Layout / reading order | Inline `<\|ref\|>`/`<\|det\|>` grounding tokens with bboxes | Two-stage (PP-DocLayoutV2 + VLM); 1.6 adds one-shot `Spotting:` |
| Handwriting | **Not documented** | **Explicitly claimed** (plus historical docs, seals) |
| Exhibit images | `<\|det\|>image [bbox]\|` regions directly usable for cropping exhibits | Layout stage returns image regions |
| Languages | Multilingual, count unspecified | **109 documented** |

Both emit bbox-tagged elements; assembling markdown/JSON from the raw output is TypeScript work either way (Unlimited-OCR's reference post-processor is ~30 lines of regex over `<|det|>` markers).

## Deployment without Python — where they diverge sharply

### PaddleOCR-VL-1.6: the only official Metal-capable HTTP path ✅

`PaddlePaddle/PaddleOCR-VL-1.6-GGUF` is published by the PaddlePaddle org itself (719k downloads), ships the mmproj, and cites **merged** llama.cpp support (PR #18825):

```bash
llama-server -m PaddleOCR-VL-1.6.gguf --mmproj PaddleOCR-VL-1.6-mmproj.gguf \
  --port 8080 --host 0.0.0.0 --temp 0
```

That's an OpenAI-compatible `/v1` endpoint at ~1 GB of weights that runs on Apple Silicon. There is also an official vLLM/SGLang server image (`paddlex-genai-vllm-server`) for CUDA.

Nuance on the Python layout stage: the `paddleocr` pip package orchestrates layout → recognition → Markdown/JSON assembly, and the 0.9B HF repo ships a `PP-DocLayoutV2/` Paddle model for layout. **The 1.6 repo contains no `PP-DocLayoutV2/` directory**, and 1.6's `Spotting:` task returns whole-page text + boxes — suggesting the separate Paddle layout stage is no longer required, though docs still describe the two-stage pipeline (not definitively confirmed). Either way, we'd do assembly in TS from bbox-tagged output.

Known (closed) llama.cpp issues to note: M4 CPU-only crash #23631, Windows AMD zero-output #22551, 1.6 eval bug #25339.

### Unlimited-OCR: cleanest OpenAI contract, but CUDA-only today ⚠️

Official vLLM recipe (single GPU, **≥8 GB VRAM BF16**):

```bash
docker run --rm --gpus all --network host --ipc host \
  vllm/vllm-openai:unlimited-ocr baidu/Unlimited-OCR --trust-remote-code \
  --logits_processors vllm.model_executor.models.unlimited_ocr:NGramPerReqLogitsProcessor \
  --no-enable-prefix-caching --mm-processor-cache-gb 0
```

Client side is plain `POST /v1/chat/completions` with a base64 `data:` image and `extra_body: {skip_special_tokens: false, vllm_xargs: {ngram_size: 35, window_size: 128}}` — drivable from Node with `fetch`. Caveats:

- The architecture is **not in a stable vLLM pip wheel** — you must use the dedicated `vllm/vllm-openai:unlimited-ocr` (CUDA 13.0) or `-cu129` (Hopper) image. No official Metal path.
- **llama.cpp/Ollama trap:** the GGUF converter was merged as **"full MHA"** (PR #24969); the R-SWA implementation (PR #24975) is **still open**. Running Unlimited-OCR via llama.cpp today loses the constant-KV-cache property — the model's entire reason to exist for long documents. Don't route it through Ollama until #24975 lands.
- Unofficial `mlx-community/Unlimited-OCR-mxfp8` exists (MLX format — what DMR's vllm-metal loads) but has ~395 downloads and is unverified.

### Catalog availability

Neither model is in the Ollama library or the Docker Model Runner catalog today. What **is** in both: **`deepseek-ocr`** and **`glm-ocr`** — `deepseek-ocr` is the available approximation of Unlimited-OCR's lineage (minus the flat-KV-cache benefit).

## Recommendation

**PaddleOCR-VL-1.6 first.** Official GGUF + mmproj, documented `llama-server` command, merged upstream support, ~1 GB VRAM, Apache-2.0, and it covers the capabilities court PDFs actually need that Unlimited-OCR doesn't document: handwriting, tables via dedicated prompt, charts, seals, 109 languages. Fits the existing host-runtime pattern on Mac operators with no Python in the app.

**Unlimited-OCR for CUDA sidecars where long-document throughput matters.** Its multi-page single-pass parsing with flat KV cache is genuinely differentiated for 50-page filings, and its vLLM recipe is the cleanest OpenAI-compatible contract of the two. MIT. It fits the existing vLLM CUDA sidecar role exactly (add a `ContainerDef` for the `vllm/vllm-openai:unlimited-ocr` image).

The pragmatic split mirrors Sound Suite's existing runtime split:

- **Mac / laptop operators** → PaddleOCR-VL-1.6 via llama-server (or DMR once cataloged)
- **CUDA sidecars** → Unlimited-OCR via the official vLLM image
- **Available-today stopgap in Ollama/DMR catalogs** → `deepseek-ocr` (already close to our current `richardyoung/olmocr2:7b-q8` default in role)

## Sources

- https://arxiv.org/abs/2606.23050 · https://github.com/baidu/Unlimited-OCR · https://huggingface.co/baidu/Unlimited-OCR
- vLLM recipe: https://recipes.vllm.ai/baidu/Unlimited-OCR
- https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6 · https://huggingface.co/PaddlePaddle/PaddleOCR-VL-1.6-GGUF
- https://ernie.baidu.com/blog/posts/paddleocr-vl/

## See also

- `TODO-paddleocr-vl-and-readiness-score.md` — the readiness-score quality gate paired with better OCR
- `research-ocr-structured-parsing-roadmap.md` — integration plan against the actual pipeline
