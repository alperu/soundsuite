"""
ss-rlm-sandbox — an OpenAI-compatible front door for the RLM pattern.

The `rlms` library is a library, not a service: it exposes `RLM.completion()`.
The Sound Suite master dials this role as an OpenAI-compatible endpoint on 8101
(`resolveRlmEndpoint()` in src/lib/ai/stream-rlm.ts), so this file is the
adapter between the two. It is the only code we write; the recursion, the REPL
and the sub-call machinery are the library's.

Topology (docs/DESIGN-ss-rlm-sandbox-runtime.md):

    master :3000  ──POST /v1/chat/completions──▶  THIS :8101
                                                    │
                                                    ├─ RLM(environment="local")
                                                    │  model-written Python,
                                                    │  in-process
                                                    │
                                                    └─ sub-model calls ──▶
                                                       sidecar /api/v1  ──▶
                                                       OpenRouter

Why environment="local" and not the library's DockerREPL: DockerREPL shells out
to the `docker` CLI to spawn nested containers, which needs /var/run/docker.sock
inside this container. SPEC-ss-rlm-sandbox.md §4 forbids that, and the sidecar
does not pass the socket to role containers. This container IS the isolation
boundary — which is that spec's own reasoning, applied one layer out.

No API key lives here. `SS_SIDECAR_URL` points at the sidecar's virtual-chat
route, which holds the per-master OpenRouter key and resolves the model. A key
in this process would be a key inside model-written code.
"""

import json
import os
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rlm import RLM

# ── Configuration ─────────────────────────────────────────────────────────────

PORT = int(os.getenv("PORT", "8101"))

# Where sub-model calls go. NOT OpenRouter directly — the sidecar route, which
# holds the key. Trailing /api/v1 because that is where the sidecar's
# OpenAI-compatible shim lives (Next.js app router: /api/v1/chat/completions).
SIDECAR_URL = os.getenv("SS_SIDECAR_URL", "http://host.docker.internal:8098/api/v1")

# The sidecar resolves the real model from the calling master's own config and
# IGNORES whatever we send — deliberately, so a model-written loop cannot talk
# its way onto an unauthorised model. This value is only for the library's
# internal bookkeeping (context-limit lookups, per-model usage counters).
MODEL_HINT = os.getenv("SS_SANDBOX_MODEL", "deepseek/deepseek-v4-flash")

# Forwarded as X-SoundSuite-Master so the sidecar knows whose key to spend.
# Unset is fine while one master is configured; the sidecar returns 409 rather
# than guessing once there are two.
MASTER_URL = os.getenv("SS_MASTER_URL", "").strip()

# The OpenAI SDK requires a non-empty api_key. The sidecar does not check it —
# see the auth note in the route. This is a placeholder, never a credential.
PLACEHOLDER_KEY = "sandbox-no-key-needed"


def _int_env(name, default):
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return int(raw)
    except ValueError:
        print(f"[config] {name}={raw!r} is not an integer — using {default}", file=sys.stderr)
        return default


def _float_env(name, default):
    raw = os.getenv(name, "").strip()
    if not raw:
        return default
    try:
        return float(raw)
    except ValueError:
        print(f"[config] {name}={raw!r} is not a number — using {default}", file=sys.stderr)
        return default


# Safety rails. SPEC §4: "Model-written loops do not reliably terminate."
# max_timeout is the primary one — the others bound cost and error storms.
MAX_TIMEOUT = _float_env("SS_MAX_TIMEOUT", 300.0)
MAX_ITERATIONS = _int_env("SS_MAX_ITERATIONS", 30)
MAX_ERRORS = _int_env("SS_MAX_ERRORS", 5)
MAX_DEPTH = _int_env("SS_MAX_DEPTH", 1)
MAX_CONCURRENT_SUBCALLS = _int_env("SS_MAX_CONCURRENT_SUBCALLS", 4)
MAX_TOKENS = _int_env("SS_MAX_TOKENS", 0) or None

# max_budget reads `usage.cost` off the response (rlm/clients/openai.py
# _track_cost). It is NOT gated on base_url, and the sidecar route forwards
# OpenRouter's usage object verbatim with `usage: {include: true}` — so this
# rail is live through the proxy. If the route ever starts reshaping the
# response, this silently becomes a no-op; that is why the route says so.
MAX_BUDGET_USD = _float_env("SS_MAX_BUDGET_USD", 0.0) or None


def build_rlm():
    """A fresh RLM per request: completion() spawns and tears down its own
    environment and LM handler, and sharing one across concurrent requests would
    share REPL state between unrelated callers."""
    default_headers = {"X-SoundSuite-Master": MASTER_URL} if MASTER_URL else None
    return RLM(
        backend="openai",
        backend_kwargs={
            "model_name": MODEL_HINT,
            "api_key": PLACEHOLDER_KEY,
            "base_url": SIDECAR_URL,
            **({"default_headers": default_headers} if default_headers else {}),
        },
        environment="local",
        max_depth=MAX_DEPTH,
        max_iterations=MAX_ITERATIONS,
        max_timeout=MAX_TIMEOUT,
        max_errors=MAX_ERRORS,
        max_concurrent_subcalls=MAX_CONCURRENT_SUBCALLS,
        **({"max_tokens": MAX_TOKENS} if MAX_TOKENS else {}),
        **({"max_budget": MAX_BUDGET_USD} if MAX_BUDGET_USD else {}),
        # custom_tools is STUBBED in v1. With environment="local" these would be
        # ordinary Python callables (the code-string constraint applies only to
        # isolated environments), but the master does not yet expose
        # query_case_knowledge / query_case_graph over HTTP. The loop runs and
        # reasons over the prompt it is given; it cannot retrieve.
        # See DESIGN §7.
        custom_tools=None,
        verbose=False,
    )


# ── Prompt assembly ───────────────────────────────────────────────────────────


def messages_to_prompt(messages):
    """Flatten an OpenAI message array into the single prompt RLM takes.

    RLM's entry point is `completion(prompt)`, not a message list — the context
    it will chunk and recursively query IS the prompt. Roles are preserved as
    labels so a system instruction stays distinguishable from the payload.
    """
    parts = []
    for m in messages:
        if not isinstance(m, dict):
            continue
        role = str(m.get("role", "user"))
        content = m.get("content", "")
        if isinstance(content, list):
            # Multimodal content blocks: keep the text, drop the rest. The
            # sandbox reasons over text; an image block would otherwise be
            # rendered as a dict repr into the prompt.
            content = "\n".join(
                b.get("text", "") for b in content if isinstance(b, dict) and b.get("type") == "text"
            )
        content = str(content)
        parts.append(content if role == "user" else f"[{role}]\n{content}")
    return "\n\n".join(p for p in parts if p.strip())


def openai_response(text, model, usage_summary=None):
    """Shape an OpenAI chat-completion response. The master parses this with the
    same code path it uses for the self-hosted ss-rlm vLLM endpoint."""
    usage = {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0}
    if usage_summary:
        try:
            d = usage_summary.to_dict() if hasattr(usage_summary, "to_dict") else dict(usage_summary)
            totals = d.get("totals") or d
            usage = {
                "prompt_tokens": int(totals.get("input_tokens", 0) or 0),
                "completion_tokens": int(totals.get("output_tokens", 0) or 0),
                "total_tokens": int(totals.get("total_tokens", 0) or 0),
                "cost": totals.get("cost"),
            }
        except Exception:
            # Usage accounting must never fail a good answer.
            pass
    return {
        "id": f"rlmsandbox-{int(time.time() * 1000)}",
        "object": "chat.completion",
        "created": int(time.time()),
        "model": model,
        "choices": [
            {
                "index": 0,
                "message": {"role": "assistant", "content": text},
                "finish_reason": "stop",
            }
        ],
        "usage": usage,
    }


# ── HTTP ──────────────────────────────────────────────────────────────────────


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        print(f"[http] {fmt % args}", file=sys.stderr)

    def _send(self, status, payload):
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _error(self, status, message):
        self._send(status, {"error": {"message": message, "type": "sandbox_error", "code": status}})

    def do_GET(self):
        if self.path.rstrip("/") in ("/health", "/healthz"):
            self._send(200, {"ok": True, "model": MODEL_HINT, "sidecar": SIDECAR_URL})
        elif self.path.rstrip("/") in ("/v1/models", "/models"):
            self._send(200, {"object": "list", "data": [{"id": MODEL_HINT, "object": "model"}]})
        else:
            self._error(404, f"no route {self.path}")

    def do_POST(self):
        if self.path.rstrip("/") not in ("/v1/chat/completions", "/chat/completions"):
            self._error(404, f"no route {self.path}")
            return

        try:
            length = int(self.headers.get("Content-Length") or 0)
            body = json.loads(self.rfile.read(length) or b"{}")
        except Exception as e:
            self._error(400, f"body must be JSON: {e}")
            return

        messages = body.get("messages")
        if not isinstance(messages, list) or not messages:
            self._error(400, "messages must be a non-empty array")
            return

        if body.get("stream"):
            # The master's sandbox path collects a whole answer. Accepting
            # stream:true and then not streaming would hang the caller.
            self._error(400, "stream is not supported — request a non-streaming completion")
            return

        prompt = messages_to_prompt(messages)
        if not prompt.strip():
            self._error(400, "messages contained no text content")
            return

        started = time.time()
        try:
            result = build_rlm().completion(prompt)
        except Exception as e:
            took = time.time() - started
            print(f"[rlm] failed after {took:.1f}s: {type(e).__name__}: {e}", file=sys.stderr)
            self._error(502, f"{type(e).__name__}: {e}")
            return

        took = time.time() - started
        # `.error` is set when the call itself failed; `.response` is then empty.
        # Returning that as a successful empty answer would look like the model
        # had nothing to say.
        err = getattr(result, "error", None)
        if err:
            print(f"[rlm] completed with error after {took:.1f}s: {err}", file=sys.stderr)
            self._error(502, str(err))
            return

        text = getattr(result, "response", "") or ""
        print(f"[rlm] answered in {took:.1f}s ({len(text)} chars)", file=sys.stderr)
        self._send(200, openai_response(text, MODEL_HINT, getattr(result, "usage_summary", None)))


def main():
    print(
        f"[boot] ss-rlm-sandbox on :{PORT}\n"
        f"       sub-model calls -> {SIDECAR_URL}\n"
        f"       model hint       {MODEL_HINT} (the sidecar resolves the real one)\n"
        f"       master           {MASTER_URL or '(unset — sidecar must have exactly one configured)'}\n"
        f"       rails            timeout={MAX_TIMEOUT}s iterations={MAX_ITERATIONS} "
        f"errors={MAX_ERRORS} depth={MAX_DEPTH} budget={MAX_BUDGET_USD or 'unset'}\n"
        f"       tools            STUBBED (master HTTP tool endpoints not built — DESIGN §7)",
        file=sys.stderr,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
