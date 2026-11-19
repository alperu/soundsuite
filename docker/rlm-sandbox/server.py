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
                                                    ├─ GET sidecar /api/rlm-sandbox/master-config
                                                    │  (that master's key, model, domain;
                                                    │   X-Sandbox-Token; cached 60 s)
                                                    │
                                                    ├─ RLM(environment="local")
                                                    │  model-written Python, in-process
                                                    │
                                                    └─ sub-model calls ──▶ OpenRouter (direct)

Why environment="local" and not the library's DockerREPL: DockerREPL shells out
to the `docker` CLI to spawn nested containers, which needs /var/run/docker.sock
inside this container. SPEC-ss-rlm-sandbox.md §4 forbids that, and the sidecar
does not pass the socket to role containers. This container IS the isolation
boundary — which is that spec's own reasoning, applied one layer out.

Keys (docs/tasks/59): the sidecar holds each master's OpenRouter key, model
and domain (its per-master sandbox slot). Per request this server fetches the
calling master's slot from the sidecar's local hand-off route and calls
OpenRouter directly with it. The key is held in memory only for that master's
requests, is never logged, and is scrubbed from error text. It does sit in the
same process as model-written code — a known trade-off of dropping the proxy.

Older sidecars have no hand-off route. When it answers 404 WITHOUT the
`X-Sandbox-Handoff` marker, this server falls back to the old sidecar chat
route (`SS_SIDECAR_URL`), which held the key itself. Follow-up: remove that
fallback once every host runs a sidecar with the hand-off route.
"""

import json
import os
import sys
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from rlm import RLM

# ── Configuration ─────────────────────────────────────────────────────────────

PORT = int(os.getenv("PORT", "8101"))

# This sidecar's API base (`.../api/v1`). The hand-off route is its sibling
# `.../api/rlm-sandbox/master-config`; `.../api/v1/chat/completions` is the old
# chat route used only by the legacy fallback.
SIDECAR_URL = os.getenv("SS_SIDECAR_URL", "http://host.docker.internal:8098/api/v1").rstrip("/")
SIDECAR_API = SIDECAR_URL[: -len("/v1")] if SIDECAR_URL.endswith("/v1") else SIDECAR_URL
HANDOFF_URL = SIDECAR_API + "/rlm-sandbox/master-config"

# Shared secret the sidecar passed in when it created this container.
SANDBOX_TOKEN = os.getenv("SS_SANDBOX_TOKEN", "").strip()

OPENROUTER_URL = os.getenv("SS_OPENROUTER_URL", "https://openrouter.ai/api/v1").rstrip("/")

# Seconds a master's {key, model, domain} is cached here.
HANDOFF_TTL = 60.0

# The model actually used comes from the hand-off, per master. This value is
# only a label for /health, /v1/models and the legacy path's bookkeeping.
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


VALID_DOMAINS = ("legal", "code")

# Identity and domain each have a canonical name and a Fantom-prefixed alias.
# Fantom shipped X-FantomMCP-* before this side read either, and Sound Suite
# uses X-SoundSuite-*; accepting both means neither has to redeploy in step
# with the other. Order matters only in that the first present wins.
MASTER_HEADERS = ("X-SoundSuite-Master", "X-FantomMCP-Master")
DOMAIN_HEADERS = ("X-SoundSuite-Domain", "X-FantomMCP-Domain")


def first_header(headers, names):
    """First present, non-empty value among `names`. Case-insensitive —
    BaseHTTPRequestHandler's mapping already is, but be explicit."""
    for n in names:
        v = headers.get(n) or headers.get(n.lower())
        if v and v.strip():
            return v.strip()
    return None


def tools_for_domain(domain):
    """REPL tools for a retrieval domain.

    Returns None (no tools) for an unknown or absent domain — deliberately, not
    a default. Handing a code caller legal retrieval answers confidently and
    wrongly, which is worse than answering with no retrieval at all.

    Both branches are empty today: neither master exposes its tools over HTTP.
    When they do, each becomes a dict of plain Python callables (possible
    because environment="local" keeps them in-process; the code-string
    constraint in the original design note applies only to isolated
    environments).
    """
    if domain == "legal":
        return None  # TODO: query_case_knowledge, query_case_graph
    if domain == "code":
        return None  # TODO: search_code, search_symbols, search_files
    return None


class HandoffError(Exception):
    """The sidecar answered the hand-off with a real error (it carries the
    marker): 401 token, 404 no slot, 409 ambiguous, 503 no key/model."""

    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


_handoff_cache = {}
_handoff_lock = threading.Lock()


def fetch_master_config(master):
    """{master, apiKey, model, domain} for `master` (or the sidecar's single
    configured master when None), cached HANDOFF_TTL seconds. Returns None when
    the sidecar is too old to have the route (404 without the marker) or no
    token was passed in — the caller then uses the legacy chat route."""
    if not SANDBOX_TOKEN:
        return None
    cache_key = master or ""
    now = time.time()
    with _handoff_lock:
        hit = _handoff_cache.get(cache_key)
        if hit and now - hit[0] < HANDOFF_TTL:
            return hit[1]

    url = HANDOFF_URL + (("?master=" + urllib.parse.quote(master, safe="")) if master else "")
    req = urllib.request.Request(url, headers={"X-Sandbox-Token": SANDBOX_TOKEN})
    try:
        with urllib.request.urlopen(req, timeout=10) as res:
            cfg = json.loads(res.read() or b"{}")
    except urllib.error.HTTPError as e:
        marked = e.headers.get("X-Sandbox-Handoff") == "1"
        if e.code == 404 and not marked:
            return None  # older sidecar: no hand-off route
        try:
            msg = json.loads(e.read() or b"{}").get("error", {}).get("message") or str(e)
        except Exception:
            msg = str(e)
        raise HandoffError(e.code, msg)
    except (urllib.error.URLError, OSError) as e:
        raise HandoffError(502, f"sidecar hand-off unreachable: {e}")

    if not cfg.get("apiKey") or not cfg.get("model"):
        raise HandoffError(503, "sidecar hand-off returned no key or model")
    with _handoff_lock:
        _handoff_cache[cache_key] = (now, cfg)
    return cfg


def redact(text, cfg):
    """Strip the master's key from any text that may reach a log or a caller."""
    key = (cfg or {}).get("apiKey")
    return text.replace(key, "<redacted>") if key and text else text


def build_rlm(master_url=None, domain=None, cfg=None):
    """A fresh RLM per request: completion() spawns and tears down its own
    environment and LM handler, and sharing one across concurrent requests would
    share REPL state between unrelated callers.

    `master_url` is the caller's identity, taken from the incoming request and
    forwarded on every sub-model call. It has to be per-request rather than
    per-container: two masters register on the same sidecar and each has its own
    key, model and budget, so a container-wide value would make one master's
    traffic spend the other's money. The sidecar refuses with 409 rather than
    guess, which is what surfaces here if the header is missing.

    `domain` is which retrieval world this caller lives in — 'legal' (Sound
    Suite, case law) or 'code' (Fantom, a codebase). It selects which tools get
    injected into the REPL. Getting it wrong does not error; it answers a code
    question with legal retrieval, which is the confidently-wrong failure the
    two-master contract exists to prevent. So an unrecognised value yields NO
    tools rather than a guess.
    """
    effective_master = (master_url or MASTER_URL or "").strip()
    # The header wins (as before); the domain the master declared in its
    # config push fills in when the header is absent.
    if not domain and cfg:
        domain = cfg.get("domain")
    effective_domain = domain if domain in VALID_DOMAINS else None

    if cfg:
        # Direct to OpenRouter with this master's key and model. Master
        # identity headers stay off: OpenRouter does not need them.
        # `usage: {include: true}` is what max_budget reads (usage.cost); the
        # library only adds it for another base URL, so pass it ourselves.
        backend_kwargs = {
            "model_name": cfg["model"],
            "api_key": cfg["apiKey"],
            "base_url": OPENROUTER_URL,
            "sampling_args": {"extra_body": {"usage": {"include": True}}},
        }
    else:
        backend_kwargs = None

    default_headers = {}
    if effective_master:
        # Canonical name, plus the Fantom-prefixed alias they already send, so
        # whichever the sidecar reads works without a redeploy on either side.
        default_headers["X-SoundSuite-Master"] = effective_master
        default_headers["X-FantomMCP-Master"] = effective_master
    if effective_domain:
        default_headers["X-SoundSuite-Domain"] = effective_domain
        default_headers["X-FantomMCP-Domain"] = effective_domain

    if backend_kwargs is None:
        # Legacy (older sidecar): its chat route holds the key and resolves the
        # model; identity headers tell it whose slot to use.
        backend_kwargs = {
            "model_name": MODEL_HINT,
            "api_key": PLACEHOLDER_KEY,
            "base_url": SIDECAR_URL,
            **({"default_headers": default_headers} if default_headers else {}),
        }

    return RLM(
        backend="openai",
        backend_kwargs=backend_kwargs,
        environment="local",
        max_depth=MAX_DEPTH,
        max_iterations=MAX_ITERATIONS,
        max_timeout=MAX_TIMEOUT,
        max_errors=MAX_ERRORS,
        max_concurrent_subcalls=MAX_CONCURRENT_SUBCALLS,
        **({"max_tokens": MAX_TOKENS} if MAX_TOKENS else {}),
        **({"max_budget": MAX_BUDGET_USD} if MAX_BUDGET_USD else {}),
        # Tools per domain. Still EMPTY on both sides — neither master exposes
        # query_case_knowledge/query_case_graph ('legal') nor
        # search_code/search_symbols/search_files ('code') over HTTP yet. The
        # domain now reaches the exact point where they get injected, so wiring
        # them is a change to tools_for_domain() alone.
        custom_tools=tools_for_domain(effective_domain),
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
            self._send(200, {"ok": True, "model": MODEL_HINT, "sidecar": SIDECAR_API,
                             "handoff": bool(SANDBOX_TOKEN)})
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

        # Who is calling (bills the sub-model calls) and what they retrieve over
        # (selects the REPL tools). Both are per-request: one container serves
        # both masters, so neither can be a container-wide setting.
        caller = first_header(self.headers, MASTER_HEADERS)
        domain = first_header(self.headers, DOMAIN_HEADERS)

        if not caller and not MASTER_URL:
            print(f"[rlm] no {'/'.join(MASTER_HEADERS)} on request and no SS_MASTER_URL — "
                  "the sidecar will 409 if more than one master has a key", file=sys.stderr)

        # This master's key/model/domain from the sidecar (None = legacy route).
        # Errors keep their status: 404 unknown master, 409 ambiguous, 503 unset.
        try:
            cfg = fetch_master_config((caller or MASTER_URL or "").strip() or None)
        except HandoffError as e:
            print(f"[rlm] hand-off refused ({e.status}): {e.message}", file=sys.stderr)
            self._error(e.status, e.message)
            return
        if domain is None and cfg:
            domain = cfg.get("domain")
        if domain and domain not in VALID_DOMAINS:
            # Loud, because the consequence is silent: an unrecognised domain
            # gets no tools, and a caller expecting retrieval sees a plausible
            # answer built from the prompt alone.
            print(f"[rlm] domain {domain!r} is not one of {VALID_DOMAINS} — no tools will be "
                  "injected. Check the header value.", file=sys.stderr)
        elif not domain:
            print("[rlm] no domain header — using the domain from the master slot, if any. Send "
                  f"{DOMAIN_HEADERS[0]} (or {DOMAIN_HEADERS[1]}).", file=sys.stderr)

        started = time.time()
        try:
            result = build_rlm(caller, domain, cfg).completion(prompt)
        except Exception as e:
            took = time.time() - started
            msg = redact(f"{type(e).__name__}: {e}", cfg)
            print(f"[rlm] failed after {took:.1f}s: {msg}", file=sys.stderr)
            self._error(502, msg)
            return

        took = time.time() - started
        # `.error` is set when the call itself failed; `.response` is then empty.
        # Returning that as a successful empty answer would look like the model
        # had nothing to say.
        err = getattr(result, "error", None)
        if err:
            msg = redact(str(err), cfg)
            print(f"[rlm] completed with error after {took:.1f}s: {msg}", file=sys.stderr)
            self._error(502, msg)
            return

        text = getattr(result, "response", "") or ""
        model = cfg["model"] if cfg else MODEL_HINT
        print(f"[rlm] answered in {took:.1f}s ({len(text)} chars) via "
              f"{'OpenRouter direct' if cfg else 'sidecar route (legacy)'}", file=sys.stderr)
        self._send(200, openai_response(text, model, getattr(result, "usage_summary", None)))


def main():
    print(
        f"[boot] ss-rlm-sandbox on :{PORT}\n"
        f"       sub-model calls -> {OPENROUTER_URL} (key/model per master from {HANDOFF_URL})\n"
        f"       hand-off token   {'set' if SANDBOX_TOKEN else 'UNSET — legacy sidecar route ' + SIDECAR_URL}\n"
        f"       model hint       {MODEL_HINT} (the hand-off names the real one)\n"
        f"       master           {MASTER_URL or '(unset — sidecar must have exactly one configured)'}\n"
        f"       rails            timeout={MAX_TIMEOUT}s iterations={MAX_ITERATIONS} "
        f"errors={MAX_ERRORS} depth={MAX_DEPTH} budget={MAX_BUDGET_USD or 'unset'}\n"
        f"       tools            STUBBED (master HTTP tool endpoints not built — DESIGN §7)",
        file=sys.stderr,
    )
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()


if __name__ == "__main__":
    main()
