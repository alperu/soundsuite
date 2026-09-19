# SPEC — Hosted Sound Suite (`app.soundsuite.*`) — Feasibility, Architecture, Cost & Task Plan

**Status:** Draft for decision
**Date:** 2026-09-18
**Author:** drafted against the repo at `d62cdb6`
**Scope:** Turning the single-tenant Sound Suite app into a $10/month hosted product where
customers sign up on the Statamic marketing site, get their own isolated instance at
`username.<domain>`, supply their own AI API keys, connect it to Claude Desktop over MCP, and
can export their data at any time — including after their subscription lapses.

---

## 0. Executive summary

**Verdict: feasible, with three material caveats.** Nothing here requires rewriting the
application. The container, the entrypoint, the migration discipline, the backup/restore
machinery, the BYO-API-key storage and the MCP HTTP surface all already exist. The work is a
**control plane** around them, not surgery inside them.

The three caveats, in order of how much they move the numbers:

1. **Disk is the binding constraint, not CPU or RAM.** One real corpus on the dev box occupies
   **~7.4 GB** of persistent state (992 MB SQLite + 2.1 GB LanceDB + 4.3 GB exhibit page
   images). A $10/month plan cannot offer open-ended storage. A hard quota must be a
   *product* decision on the pricing page, not an ops afterthought.

2. **"Customers bring their own API keys" does not remove your compute cost.** It removes
   embedding and LLM cost. It does **not** remove OCR. `pipeline.ocrProvider` accepts only
   `'local'` (CPU PaddleOCR in a child process) or `'ollama'` (an HTTP vision model needing a
   GPU host) — `src/lib/db/config.ts:155`. There is no path where a customer's OpenAI key does
   their OCR. OCR of scanned pages is therefore **your** CPU bill and must be metered.

3. **The app has no tenant isolation whatsoever.** No Prisma model carries a `userId`, `Config`
   is a global key-value table, `AdminUser` is global, and `docs/roadmap-docker-mcp.md`
   lists "Multi-tenant SaaS" as an explicit **non-goal**. Isolation must therefore be the
   container boundary — one container and one volume per tenant. This is the right call
   anyway; retrofitting row-level tenancy across ~35 models is a multi-month rewrite.

**Recommended path:** Fly.io Machines for v1 (0→~40 tenants; per-machine volumes, suspend/start
API and scale-to-zero are built in, so you skip building an orchestrator), migrating to Hetzner
dedicated + Docker + Traefik + Sablier **earlier than a naive reading suggests** — see the
caveat below.

**The economics caveat that drives the platform choice.** Fly's advantage here is scale-to-zero.
But §2.3 concludes you *cannot* aggressively sleep tenants, because a 90-second cold start
breaks MCP tool calls from Claude Desktop. The usable sleep policy is therefore "overnight and
weekends only" — roughly a **50% duty cycle, not 10%**. That halves the discount Fly is being
chosen for, and lands Fly at **~47% gross margin** (§7.1) versus **~82% on Hetzner** (§7.2).

So the honest framing is: Fly buys **speed to market and zero ops**, not cost. It is the right
choice for validating demand, and the wrong choice to still be on at 100 tenants. Crossover is
**~40 tenants** (§7.4), and the control plane must be written against a driver interface (§4)
so the move costs one class rather than a rewrite.

**Unit economics:** at 150 tenants on Hetzner, ~$1.24/tenant infrastructure + $0.59 Stripe =
**~82% gross margin**. At 10 tenants on Fly, **~27% margin** — viable but not profitable after
labour. **Break-even including modest ops time is ~25–30 tenants.** Details in §7.

---

## 1. What already exists (and therefore is not work)

This section matters because it is the difference between a 3-week project and a 3-month one.
Every item below was verified in the repo.

| Capability | Where | Notes |
|---|---|---|
| Production container | `Dockerfile` | Multi-stage, glibc `bookworm-slim` (required — native modules ship glibc prebuilds), Next.js standalone output |
| Compose topology | `docker-compose.yml` | `app` + `redis`, named volumes, healthcheck with `start_period: 90s` |
| Boot-time migration | `docker/entrypoint.sh` | Creates versioned data-dir layout, runs `prisma migrate deploy` (never `dev`), execs the server |
| Data-dir discipline | `SOUND_SUITE_DATA_DIR=/data`, `LAYOUT_VERSION` | All mutable state under one mount — exactly what a per-tenant volume needs |
| Backup / restore | `src/app/api/backup/route.ts`, `scripts/manage.mjs db:backup\|db:restore` | Produces a directory with `sound-suite.db` + `lancedb/` + `manifest.json` |
| BYO API keys | `src/app/api/admin/ai-keys/route.ts` | Stores per-install keys in the `Config` table for openai, anthropic, gemini, groq, grok, ollama, openrouter |
| Admin auth | `model AdminUser` (bcrypt), `requireAdminAuth` | Single admin per install — which is exactly one tenant |
| MCP over HTTP | `/api/mcp/tools`, `/api/mcp/execute` | With `MCP_AUTH_MODE=apikey` and per-install keys |
| MCP client bridge | `scripts/mcp-bridge/bridge.mjs` | stdio↔HTTP shim; already targets a configurable `SOUND_SUITE_URL` |
| Remote-origin auth logic | `src/lib/mcp/execute-auth.ts` | Classifies loopback vs remote, enforces a key on remote callers |
| Cloudflare tunnel config | `src/lib/admin/cloudflare.ts`, `/api/admin/cloudflare` | Domain, account ID, tunnel ID/token, ingress paths already modelled |
| Health endpoint | `/api/health` | Reports FileWatcher, JobQueue, DB connectivity, row counts |

### 1.1 Two findings that change the topology

**Finding A — the MCP server on port 3001 is not what Claude Desktop uses.**
`MCP_PORT=3001` appears in `.env.example` and `docker-compose.yml:23` exposes it, but nothing
in `src/lib/services-manager.ts` or `src/lib/mcp/mcp-server.ts` starts a listener on it. The
actual client path is:

```
Claude Desktop ──stdio──▶ scripts/mcp-bridge/bridge.mjs ──HTTPS──▶ :3000 /api/mcp/tools
                                                                    :3000 /api/mcp/execute
```

`bridge.mjs:22` defaults `SOUND_SUITE_URL` to `http://127.0.0.1:3000`.

**Consequence:** ingress routes **one port per tenant**, not two. Drop `3001` from the tenant
container spec. The customer's Claude Desktop config just sets
`SOUND_SUITE_URL=https://alice.soundsuite.app` and an API key.

**Finding B — `REDIS_URL` is a dead environment variable (live bug).**
`src/lib/redis.ts:27` reads `REDIS_HOST` / `REDIS_PORT` / `REDIS_PASSWORD` and nothing else. A
repo-wide grep (all `.ts/.js/.mjs/.sh/.json/.yml/.md`, excluding `node_modules` and `.next`)
finds `REDIS_URL` **set** in three places and **documented** in two, but **read in none**:

| File | Line | Role |
|---|---|---|
| `docker-compose.yml` | 27 | sets `REDIS_URL=redis://redis:6379` |
| `.github/workflows/ci.yml` | 45 | sets `REDIS_URL=redis://localhost:6379` |
| `docs/roadmap-docker-mcp.md` | 162 | documents it as the Redis connection var |
| `docs/application-overview.md` | 161 | documents it as the Redis connection string |
| *(no source file)* | — | **no reader anywhere** |

So in the current image the client falls back to `127.0.0.1:6379`, where nothing is listening,
and every Redis-backed feature (folder index cache, filings cache, SSE events, worker pool)
silently degrades. CI has the same gap, which is why no test caught it.

**Fix direction:** since compose, CI and two docs all already assume `REDIS_URL`, the smaller
blast radius is to **teach `src/lib/redis.ts` to parse `REDIS_URL`** (falling back to the
existing host/port/password vars) rather than to change three call sites and two docs. Either
way this is blocking — see P1.

---

## 2. Feasibility assessment

### 2.1 Resource envelope per tenant

**Disk — the binding constraint.** Measured on the dev machine for one heavily-used corpus:

| Component | Size | Notes |
|---|---:|---|
| `public/exhibits/` (page images) | **4.3 GB** | Largest single item; PNG/JPEG renders |
| `data/lancedb/` (vectors) | **2.1 GB** | Grows linearly with chunk count |
| `prisma/data/sound-suite.db` | **992 MB** | Page cache, chunks, structure, scores |
| `data/chat-attachments/` | 109 MB | |
| **Total persistent state** | **~7.4 GB** | One power user |

Two derived conclusions:

- **Move exhibit images off block storage.** Shipping them to R2 and serving signed URLs cuts
  per-tenant block storage by ~58%, from 7.4 GB to ~3.1 GB, at $0.015/GB/month instead of
  $0.0476/GB/month (Hetzner volume) or $0.15/GB/month (Fly volume). This is the single highest-leverage
  infrastructure change in this document.
- **The dev backup strategy cannot be the tenant backup strategy.** `manage.mjs db:backup`
  does a full `copyFileSync` of the SQLite file; `prisma/data/` currently holds **ten**
  `~985 MB` `.bak.*` copies. At a 10 GB quota, ten backups *is* the quota. Tenants get one
  rolling slot on-volume, with the durable copy pushed off-volume to R2.

**RAM.** With BYO keys (so `@xenova/transformers` is never loaded) and no ingestion running,
a tenant container idles at roughly **350–500 MB RSS** (Next.js standalone + chokidar
FileWatcher + p-queue + a small Redis). During ingestion, pdfjs page rendering, `sharp` and the
PaddleOCR child process push peaks to **1.5–3 GB**. Budget 512 MB reserved, 2 GB burst limit.

**CPU.** Near-zero at idle. Ingestion is the spike: OCR runs only on low-text-density pages,
so cost depends entirely on corpus mix. Natively-text-layered e-filed PDFs skip OCR almost
entirely; scanned records and exhibits do not. `JOB_CONCURRENCY=2` by default — pin tenants to
1 on the Starter plan.

### 2.2 What makes $10/month work, and what breaks it

**Works because:**
- Idle is genuinely cheap (~400 MB, ~0% CPU), and most tenants are idle most of the time.
- Embedding and LLM inference are on the customer's own key — the two costs that would
  otherwise be unbounded and unpredictable.
- Storage is capped by policy.

**Breaks if:**
- OCR is uncapped. One tenant dropping a 10,000-page scanned record set will saturate several
  cores for hours. **Hard cap OCR pages per month** and queue them at low priority.
- Storage is uncapped. See above.
- Every tenant is kept always-on with no scale-to-zero *and* you pay per-second cloud pricing.
- You attempt to serve the `ollama` OCR provider yourself. A GPU host (the code comments
  reference an A6000 48 GB) is a $200–500/month line item that no number of $10 subscriptions
  at low tenant count will support. **Ship `ocrProvider: 'local'` only**; treat GPU OCR as a
  future premium tier or a customer-supplied endpoint.

### 2.3 The cold-start problem (do not skip this)

`docker-compose.yml` sets `start_period: 90s` on the healthcheck. That is the measured boot
budget — Prisma migrate check, Next.js standalone start, service manager init. A 90-second
cold start is invisible for a dashboard visit behind a loading page, and **fatal for an MCP
tool call from Claude Desktop**, which will time out long before.

Mitigations, in preference order:

1. **Don't sleep during the tenant's working hours.** Sleep overnight and weekends only. Idle
   RAM is 400 MB; keeping a tenant warm 12h/day instead of 24h still halves runtime cost
   without ever showing a user a cold start. This is the recommended default.
2. **Make the bridge wake-aware.** `bridge.mjs` already polls job event streams
   (`/api/mcp/{kind}/{jobId}/events`), so async patterns are native to it. On a connection
   failure it should POST to the control plane's `/wake`, poll readiness, then retry — and
   surface "starting your instance…" to the user rather than an error.
3. **Sablier** (`github.com/acouvreur/sablier`) as a Traefik/Caddy plugin handles the
   browser-facing case: it starts a stopped container on request and serves a loading page
   while it boots. It does not solve the MCP case, which is why (2) is still needed.

### 2.4 Security posture

Because the application has **zero internal tenant isolation**, every isolation guarantee comes
from the container boundary. This raises the bar on how that boundary is configured:

- One container, one volume, one network namespace per tenant. Non-root user. `--cap-drop ALL`.
  No Docker socket mounted. Read-only rootfs except `/data` and `/tmp`.
- **Do not share a Redis instance across tenants.** The app exposes `/api/redis/key` and
  `/api/redis/keys` — routes that read arbitrary keys by name. They are admin-gated, but on a
  shared Redis a single auth bypass in one tenant becomes a **cross-tenant data breach**, and
  the application has no tenant concept with which to scope those reads. A per-tenant Redis
  inside the tenant container costs ~30 MB and removes the entire class of risk. Take that
  trade.

  Shared Redis with Redis 6 ACLs scoped to a `~tenant:{id}:*` key pattern is the RAM
  optimisation available *later* — but it is **not a routine optimisation and must not be
  adopted without a security review**. It would make those two routes load-bearing for tenant
  isolation, which is a much stronger claim than "we save 30 MB per tenant."
- **Customer API keys are stored in plaintext** in the tenant's SQLite `Config` table
  (`embedding.openaiApiKey`, `openrouter.apiKey`, …). On self-managed hosts, put tenant
  volumes on a LUKS-encrypted disk and say so in the privacy policy. On Fly, volumes are
  encrypted at rest by the platform.
- Egress: tenants make outbound calls with their own keys. Allow it, but rate-limit and log
  destinations — an unrestricted container is an open proxy otherwise.
- Never let a tenant reach the control plane's network. Separate VLAN/network.

---

## 3. Target architecture

### 3.1 Topology

```
                        ┌──────────────────────────────┐
  soundsuite.ai         │  Statamic marketing site      │  (unchanged; links only)
  (existing)            │  /pricing → "Start trial"     │
                        └───────────────┬───────────────┘
                                        │ link
                                        ▼
                        ┌──────────────────────────────┐
  app.soundsuite.app    │  CONTROL PLANE (Laravel 13)   │
                        │  • signup / login / billing   │
                        │  • Stripe Cashier + webhooks  │
                        │  • tenant lifecycle FSM       │
                        │  • provisioning job queue     │
                        │  • export / import page       │
                        │  • Postgres (tenants, events) │
                        └───────────────┬───────────────┘
                                        │ Docker API / Fly Machines API
                                        ▼
  *.soundsuite.app      ┌──────────────────────────────┐
  (wildcard, proxied)   │  INGRESS (Traefik + Sablier)  │
      via Cloudflare    │  Host-header → container      │
                        └───────────────┬───────────────┘
                     ┌──────────────────┼──────────────────┐
                     ▼                  ▼                  ▼
            ┌────────────────┐ ┌────────────────┐ ┌────────────────┐
            │ ss-tenant-alice│ │ ss-tenant-bob  │ │ ss-tenant-…    │
            │  :3000         │ │  :3000         │ │                │
            │  + redis       │ │  + redis       │ │                │
            │  vol: 10 GB    │ │  vol: 10 GB    │ │                │
            └────────────────┘ └────────────────┘ └────────────────┘
                     │                  │
                     └──────────┬───────┘
                                ▼
                     ┌────────────────────┐
                     │  Cloudflare R2     │  exhibit images + nightly
                     │  (per-tenant pfx)  │  export tarballs
                     └────────────────────┘
```

### 3.2 Why the control plane is **not** in Statamic

The marketing site must keep doing what it does. Your own `CLAUDE.md` documents that production
runs `STATAMIC_STATIC_CACHING_STRATEGY=full` and that every deploy ends with
`statamic:static:clear`, and that deploys are rsync-over-the-tree. Putting mutable tenant state
and Stripe webhooks behind a full static cache, in a tree that gets rsync'd, will fight both
mechanisms.

Run the control plane as a **separate Laravel 13 application** with its own Postgres database at
`app.soundsuite.app`. Same stack and same team skills, so Cashier, queues and Horizon are all
available, but a clean deploy boundary and no static cache. Statamic's `/pricing` page gets a
button; that is the entire coupling.

### 3.3 Tenant container spec

```yaml
# Rendered per tenant by the control plane
name: ss-tenant-{tenant_id}
image: ghcr.io/soundsuite/app:{pinned_version}
user: "10001:10001"
read_only: true
tmpfs: [/tmp]
cap_drop: [ALL]
restart: unless-stopped

environment:
  SOUND_SUITE_DATA_DIR: /data
  DATABASE_URL: file:/data/v1/db/sound-suite.db
  LAYOUT_VERSION: "1"
  NODE_ENV: production

  # Redis runs inside this container — see §2.4. NOTE: the app reads
  # REDIS_HOST/REDIS_PORT, NOT REDIS_URL. See Finding B.
  REDIS_HOST: 127.0.0.1
  REDIS_PORT: "6379"

  # Ingestion limits (Starter plan)
  JOB_CONCURRENCY: "1"
  WORKER_POOL_SIZE: "6"
  MIN_UI_WORKERS: "2"
  MIN_BG_WORKERS: "1"

  # MCP: remote callers must present a key, including on loopback
  MCP_AUTH_MODE: apikey
  MCP_AUTH_STRICT_LOOPBACK: "1"
  MCP_API_KEYS: "{generated_per_tenant}"

  # CPU OCR only. Never 'ollama' on a shared host — that needs a GPU.
  # (set via Config table at bootstrap: pipeline.ocrProvider=local)

  # First-boot admin bootstrap (see P2). NOTE: container env is readable via the
  # Docker API (`docker inspect`) and is visible in Fly machine config. Pass a
  # BCRYPT HASH, never a plaintext password, and force a rotation at first login.
  SS_BOOTSTRAP_ADMIN_USER: "{email}"
  SS_BOOTSTRAP_ADMIN_PASSWORD_HASH: "{bcrypt}"
  SS_BOOTSTRAP_FORCE_ROTATE: "1"

volumes:
  - ss-vol-{tenant_id}:/data

deploy:
  resources:
    limits:    { cpus: "2.0", memory: 2G }
    reservations: { cpus: "0.1", memory: 512M }

labels:
  traefik.enable: "true"
  traefik.http.routers.{tenant_id}.rule: "Host(`{username}.soundsuite.app`)"
  traefik.http.services.{tenant_id}.loadbalancer.server.port: "3000"
  sablier.enable: "true"
  sablier.group: "tenants"
```

Note what is **absent**: no port `3001` (Finding A), no `/watch/cases` bind mount (hosted
tenants upload through the UI rather than dropping files in a watched directory), and no
`EMBEDDING_PROVIDER=transformers` (BYO keys instead, so the local model is never loaded and
~400 MB of RAM is never allocated).

### 3.4 Routing: `username` → container

This is simpler than it first appears, and importantly involves **no per-tenant DNS API call**.

1. **One wildcard DNS record, created once:** `*.soundsuite.app` → A record pointing at the
   ingress host, proxied through Cloudflare (orange cloud). Adding a tenant creates no DNS
   record.
2. **Cloudflare terminates TLS** and forwards to origin. Because it is proxied, the origin IP
   is never exposed.
3. **Traefik routes on the Host header** using the Docker provider. The
   `traefik.http.routers.{id}.rule` label is set at container-create time, so routing becomes
   active the moment the container starts — no config reload, no Traefik restart.
4. **Sablier** intercepts requests for stopped containers, starts them, and holds the request
   behind a loading page.

**The TLS gotcha, and how to avoid paying for it.** Cloudflare Universal SSL (free) covers the
apex and **one** level of wildcard. So:

- `alice.soundsuite.app` → covered free. ✅
- `alice.app.soundsuite.ai` → **two** levels deep, not covered; requires Advanced Certificate
  Manager at **$10/month**. ❌

Registering a second domain (`soundsuite.app`, ~$20/year) is therefore **6× cheaper than ACM**
($120/year) and gives a cleaner product URL. This is the recommendation. If brand consistency
on `soundsuite.ai` is worth more than $100/year, buy ACM instead — but it is a real line item
that is easy to miss until the first certificate error.

**Optionally, skip inbound ports entirely.** `cloudflared` on the ingress host with a Cloudflare
Tunnel means no open inbound ports at all. The app already models tunnel settings
(`src/lib/admin/cloudflare.ts`), so the operational pattern is familiar.

### 3.5 Tenant lifecycle state machine

Suspension is not a boolean. Model it explicitly:

```
                 checkout.session.completed
   (none) ──────────────────────────────────▶ provisioning
                                                   │ container healthy
                                                   ▼
                          invoice.paid   ┌───▶  active  ◀──┐
                                         │        │        │ invoice.paid
                                         │        │ invoice.payment_failed
                                         │        ▼        │
                                         └──── past_due ───┘
                                                  │ grace expired (7 days)
                                                  │ OR subscription.deleted
                                                  ▼
                                             suspended
                                          (container stopped,
                                           volume retained,
                                           EXPORT STILL WORKS)
                                                  │ +30 days
                                                  ▼
                                               purged
                                        (volume destroyed; R2
                                         export kept +60 days)
```

**The ordering that matters.** The export page must work while a tenant is suspended, but
`/api/backup` needs the app to be *running*. So the transition into `suspended` is:

```
1. Set status = suspending  (block new work, drain in-flight jobs)
2. Wait for JobQueue to reach idle (poll /api/health), max 10 min, then force
3. Call POST /api/backup  ← the tenant's own app makes its own export
4. Stream the tarball to R2 at  exports/{tenant_id}/final-{ts}.tar.zst
5. Verify checksum
6. THEN stop the container
7. Set status = suspended
```

Get this order wrong and you discover in production that suspended customers cannot download
their data — which is exactly the promise being made on the pricing page. Note also step 2:
stopping mid-ingestion leaves a `PROCESSING` document row and a partially-written LanceDB
segment. The drain is not optional.

---

## 4. Provisioning platform: build vs. buy

The question "is there premade provisioning software we can use" has a real answer, and it is
**partly**. Evaluated against one test: *can it create a per-tenant app with a volume, suspend
it, and do all of that over an API?*

| Option | Per-tenant app | Volume | Suspend via API | Verdict |
|---|:---:|:---:|:---:|---|
| **Fly.io Machines** | ✅ | ✅ | ✅ | Not "provisioning software" — it *removes the need for it*. Per-machine volumes, `machines start/stop/suspend`, Anycast routing, scale-to-zero, encrypted volumes. **Best v1.** |
| **Coolify** (self-hosted) | ✅ | ✅ | ~ | Open-source PaaS, Docker + Traefik, REST API, multi-server. App-centric rather than tenant-centric; you still write the control plane on top. Best self-hosted PaaS fit. |
| **HashiCorp Nomad** | ✅ | ✅ | ✅ | A real orchestrator, dramatically simpler than K8s. Job API + host volumes fit this workload well. **Best self-hosted at scale.** |
| **CapRover** | ✅ | ✅ | ~ | Docker Swarm + nginx, has an API. Workable, smaller community. |
| **Dokku** | ✅ | ✅ | ❌ | Single-host, git-push oriented. Too limited. |
| **Kubernetes** | ✅ | ✅ | ✅ | StatefulSet + PVC per tenant works, but you run a full control plane for a single-container workload. Only worth it past ~500 tenants or if you already run K8s. |
| **Kamal** | ❌ | — | ❌ | A deploy tool, not multi-tenant. Wrong shape. |
| **Railway / Render / Northflank** | ✅ | ✅ | ~ | Per-service cost exceeds $10/tenant. Economics fail. |

**Nothing off the shelf does "Stripe subscription ↔ container lifecycle ↔ quota enforcement ↔
data export."** That glue is yours regardless — realistically ~2,000–3,000 lines. Choose the
platform to minimise what *surrounds* that glue, not to avoid writing it.

**Recommendation:**
- **v1 (0→50 tenants): Fly.io Machines.** Volumes, suspend, scale-to-zero and global routing
  are platform features. You write the control plane and nothing else. No ingress to operate,
  no Traefik, no Sablier, no host patching. Ship in weeks.
- **v2 (50+ tenants): Hetzner dedicated + Docker + Traefik + Sablier**, control plane unchanged
  behind a driver interface. ~4× cheaper per tenant; you take on host ops.

Write the control plane against a **`TenantDriver` interface** (`provision`, `start`, `stop`,
`suspend`, `destroy`, `snapshot`, `usage`) from day one, with `FlyDriver` and `DockerDriver`
implementations. The migration then costs one class, not a rewrite.

---

## 5. Billing integration (Stripe)

### 5.1 Signup flow

```
soundsuite.ai/pricing  ──▶  app.soundsuite.app/signup
                              │
                              ├─ email + password (or magic link)
                              ├─ choose username  ──▶ validate:
                              │     ^[a-z0-9][a-z0-9-]{2,30}$
                              │     not in RESERVED_USERNAMES
                              │       (www, api, admin, app, mail, mcp,
                              │        status, docs, blog, cdn, static, …)
                              │     unique
                              └─ Stripe Checkout ($10/mo, 14-day trial, card required)
                                      │
                                      ▼  webhook: checkout.session.completed
                              create Tenant(status=provisioning)
                                      │
                                      ▼  queued job
                              TenantDriver.provision()
                                      │
                                      ▼  health check passes
                              status=active → welcome email with:
                                • dashboard URL
                                • MCP API key
                                • ready-to-paste Claude Desktop config
```

### 5.2 Webhooks to handle

| Event | Action |
|---|---|
| `checkout.session.completed` | Create tenant, enqueue provision |
| `invoice.paid` | `past_due`/`suspended` → `active`; start container if stopped |
| `invoice.payment_failed` | → `past_due`, start 7-day grace, show in-app banner, email |
| `customer.subscription.updated` | Reconcile status; handle plan change (resize quota/limits) |
| `customer.subscription.deleted` | → suspend sequence (§3.5) |
| `customer.subscription.trial_will_end` | Email at T-3 days |

**Webhook hygiene** — three things that bite in production:
- Verify the signature with the endpoint secret. Always.
- **Idempotency:** persist `event.id` in a `processed_stripe_events` table and no-op on repeat.
  Stripe retries, and a duplicated `provision` creates two containers and two volumes.
- **Ordering:** Stripe does not guarantee it. Compare `event.created` against the tenant's
  `last_stripe_event_at` and drop stale events, or you will resurrect a cancelled tenant.

### 5.3 Claude Desktop config handed to the customer

```json
{
  "mcpServers": {
    "sound-suite": {
      "command": "npx",
      "args": ["-y", "@soundsuite/mcp-bridge"],
      "env": {
        "SOUND_SUITE_URL": "https://alice.soundsuite.app",
        "SOUND_SUITE_API_KEY": "ss_live_…"
      }
    }
  }
}
```

This requires publishing `scripts/mcp-bridge/` to npm and teaching it to send the key as
`Authorization: Bearer` (it currently assumes trusted loopback). See Task 3.2.

---

## 6. Data export & import ("run it on your own machine")

This is both a strong trust signal and, for a tool handling litigation documents, close to a
requirement. It is also cheap, because `BackupManager` already exists.

### 6.1 What the export must contain

`manage.mjs db:backup` currently copies **`sound-suite.db` + `lancedb/` + `manifest.json`**.

**Gap: it does not include `public/exhibits/`** — the 4.3 GB of extracted page images, the
largest part of a tenant's data. A customer restoring that tarball would find their exhibit
images gone. Either extend the backup to include exhibits, or (better) store exhibits in R2
per-tenant from day one and have the export pull them from there. Task 4.1.

### 6.2 Export UX

- **While active:** "Download my data" in the control plane triggers an on-demand backup,
  uploads to R2, and returns a 24-hour signed URL. Rate-limit to 1/day.
- **Nightly:** automatic export to R2, 7 rolling copies. One slot on the tenant volume, the
  rest off-volume (§2.1).
- **While suspended:** the export page stays live and serves the final tarball created during
  the suspend sequence (§3.5). This is the whole point of that ordering.
- **Retention:** volume purged 30 days after suspension; R2 export retained 90 days; then
  deleted with 14 days' email notice.

### 6.3 Self-host restore path

Ship a one-page guide plus:

```bash
# 1. Get the tarball from the export page
tar xzf soundsuite-export-YYYYMMDD.tar.zst

# 2. Point a local install at a data dir and restore
docker run -d --name soundsuite \
  -p 3000:3000 \
  -v $PWD/data:/data \
  ghcr.io/soundsuite/app:1.4.x

docker exec soundsuite node scripts/manage.mjs db:restore /data/import/backup-YYYYMMDD
```

`db:restore` already takes a pre-restore safety backup before overwriting — good behaviour to
keep and to mention in the docs, because it is exactly what a nervous customer wants to hear.

**Re-upload (import) into hosted:** accept the same tarball, validate `manifest.json`, check the
uncompressed size against the plan quota *before* extracting, then restore into a fresh volume.
Guard against zip-bombs and path traversal in the archive.

---

## 7. Costs

> All figures are estimates as of **2026-09-18**, rounded, EUR→USD at 1.08. Provider pricing
> changes; re-verify before committing. The formulas are shown so the numbers can be rechecked
> rather than trusted.

### 7.1 Option A — Fly.io Machines (recommended for v1)

Per tenant, assuming **BYO keys**, 10 GB volume, and the **duty cycle that §2.3 actually
permits**: warm 07:00–21:00 on weekdays, asleep overnight and weekends. That is
`(14h × 5d) / (24h × 7d)` ≈ **42%**, rounded to **50%** below to leave headroom for weekend
use and wake-on-request. This is *not* the ~10% duty cycle that makes scale-to-zero pricing
look dramatic — §2.3's cold-start constraint forbids that, and this table is priced accordingly.

| Line | Calculation | Monthly |
|---|---|---:|
| Machine (shared-cpu-2x, 2 GB) | ~$14/mo always-on × 50% duty | $7.00 |
| Machine (1 GB, sleep overnight, lighter tier) | ~$8/mo × 50% | *$4.00 alt* |
| Volume, 10 GB | 10 × $0.15 | $1.50 |
| Bandwidth | ~5 GB × $0.02 | $0.10 |
| **Subtotal** | | **~$5.60** |
| With exhibits on R2 (volume → 4 GB) | 4 × $0.15 + 3 GB R2 | $0.65 |
| **Optimised subtotal** | | **~$4.75** |

Add Stripe $0.59 → **~$5.35 COGS on $10 revenue = 47% gross margin.**

**Read this number honestly.** 47% is thin for infrastructure alone, before any support or
labour. It buys zero ops burden, nothing to patch, and the fastest path to a paying customer —
a correct trade while validating demand, and an expensive one after that. The usual escape
("just sleep tenants more aggressively") is **closed here** by §2.3: shorter warm windows mean
cold MCP calls, which is the feature customers are paying for. The lever is migrating to
Option B, not squeezing the duty cycle.

### 7.2 Option B — Hetzner dedicated (recommended at scale)

Host: **AX102** — Ryzen 9 7950X3D (16c/32t), 128 GB DDR5, 2×1.92 TB NVMe RAID1 — ~€109 ≈ **$118/mo**.

Capacity per node, by constraint:

| Constraint | Math | Tenants |
|---|---|---:|
| RAM | 128 GB × 70% usable ÷ 0.5 GB idle | ~180 |
| Disk (exhibits on R2, 4 GB/tenant) | 1.92 TB × 85% ÷ 4 GB | ~400 |
| Disk (exhibits on volume, 10 GB) | 1.92 TB × 85% ÷ 10 GB | ~163 |
| CPU (burst, queued OCR) | 16 cores, ~8% duty cycle | ~200 |
| **Effective** | RAM-bound with headroom | **~150** |

At 150 tenants:

| Line | Monthly | Per tenant |
|---|---:|---:|
| AX102 node | $118 | $0.79 |
| Control plane VPS (CPX31) + managed Postgres | $28 | $0.19 |
| R2 (150 × 8 GB = 1.2 TB × $0.015) | $18 | $0.12 |
| Cloudflare (free tier) + domain | $2 | $0.01 |
| Monitoring (Grafana Cloud free / self-hosted) | $0–20 | $0.07 |
| Backup egress (R2 = $0 egress) | $0 | $0.00 |
| **Infrastructure** | **~$186** | **$1.24** |
| Stripe (2.9% + $0.30) | $88 | $0.59 |
| **Total COGS** | **~$274** | **$1.83** |
| **Revenue** | **$1,500** | **$10.00** |
| **Gross margin** | | **~82%** |

### 7.3 Launch scale (10 tenants) — reality check

| Line | Monthly |
|---|---:|
| Fly machines + volumes (10 × ~$4.75) | $48 |
| Control plane VPS | $15 |
| R2 | $2 |
| Domain + Cloudflare | $2 |
| Stripe | $6 |
| **COGS** | **$73** |
| **Revenue** | **$100** |
| **Margin** | **27%** |

Viable but not profitable after any labour. **Break-even including a modest ops allocation is
around 25–30 tenants.** Worth knowing before launch rather than after.

### 7.4 Crossover

Fly's per-tenant infrastructure cost (~$4.75) versus Hetzner's (~$1.24) is a **~$3.50/tenant/month
premium** — not the ~$2.25 a 10%-duty-cycle assumption would give, because §2.3 caps the
sleep policy at ~50%.

A dedicated AX102 plus the control-plane VPS is ~$146/month of fixed cost, and the ops work to
run it is a few hours a month once the runbooks in Phase 6 exist. Crossover:

```
$146 fixed  ÷  $3.50 premium per tenant  ≈  42 tenants
```

**Crossover is ~40 tenants, not 60.** Below it, Fly is genuinely cheaper once your time is
priced in. Above it, every additional tenant on Fly costs ~$3.50/month more than it needs to —
at 100 tenants that is $350/month, which is more than the Hetzner node and the VPS combined.

Practical reading: plan the Option B migration as **Phase 9**, triggered at ~40 paying tenants,
and make sure the `TenantDriver` interface (§4) exists from day one so the trigger is cheap to
pull.

---

## 8. Plan limits (to publish on the pricing page)

> **⚠️ These numbers are provisional and not yet derived from measurement.** The storage figures
> are grounded in the real 7.4 GB corpus measured in §2.1, but **the OCR page caps are not
> grounded in anything**. The only OCR latency figure anywhere in the repo is for the *GPU*
> path — `ollama-ocr-engine.ts` documents a median of 30–40 s/page with `DEFAULT_TIMEOUT_MS =
> 90_000`. Local CPU PaddleOCR (`@gutenye/ocr-node`, the engine hosted tenants will actually
> use) has **no measured throughput number in this codebase**.
>
> Treat every OCR and page figure below as a placeholder. **Task 8.3 must produce the real
> caps**, by benchmarking local CPU OCR pages/hour/core on the target instance type, and the
> pricing page must not be published before it does.

| | **Starter — $10/mo** | **Pro — $29/mo** |
|---|---|---|
| Storage (DB + vectors + exhibits) | **10 GB** | 50 GB |
| Documents | 2,500 | 15,000 |
| **OCR pages / month** | **1,500** | 10,000 |
| Pages (non-OCR, native text) | 50,000 | 250,000 |
| CPU | 1 vCPU sustained, 2 burst | 2 sustained, 4 burst |
| RAM | 2 GB | 4 GB |
| Concurrent ingestion jobs | 1 | 3 |
| Availability | Sleeps after 30 min idle outside 07:00–21:00 local | Always warm |
| AI provider | **Bring your own key** | BYO key |
| MCP / Claude Desktop | ✅ | ✅ |
| Data export | ✅ nightly + on demand | ✅ |
| Retention after cancellation | 30 days volume / 90 days export | 30 / 90 |

**Overages:** block rather than bill. Block new ingestion at quota, keep search working, show a
clear upgrade prompt. Surprise invoices for a $10 product cost more in support and refunds than
the overage is worth.

**Enforcement mechanics:**
- **Disk:** XFS project quotas on the tenant volume (hard enforcement at the filesystem), plus
  a control-plane `du` sweep every 15 min for reporting and warning emails at 80%/95%.
- **CPU/RAM:** cgroup limits via Docker `--cpus` / `--memory` (or Fly machine size).
- **OCR pages:** counted in the app and exposed on a metering endpoint (Task 5.1); the control
  plane reads it and flips a `pipeline.ocrEnabled=false` Config row at the cap.

---

## 9. Prerequisite code changes

These are in the **application**, not the control plane. All are small; all are blocking.

| # | Change | Why | Est. |
|---|---|---|---|
| P1 | Parse `REDIS_URL` in `src/lib/redis.ts` (falling back to `REDIS_HOST`/`PORT`/`PASSWORD`) — and add a CI assertion that Redis is actually reachable | Finding B: `REDIS_URL` is set in compose + CI and documented twice, but read nowhere. Redis is silently down in the container *and* in CI | 0.5 d |
| P2 | Non-interactive admin bootstrap — create the first `AdminUser` from env at first boot if none exists | Provisioning cannot use an interactive setup wizard | 0.5 d |
| P3 | Include `public/exhibits/` in backup, or move exhibits to S3/R2 | §6.1: the largest data component is currently not exported | 2–3 d |
| P4 | Metering endpoint — `GET /api/metering` (service-token auth): doc count, page count, OCR pages this period, bytes on disk | Quota enforcement and billing have no data source today | 1 d |
| P5 | Verify `MCP_AUTH_MODE=apikey` + `MCP_AUTH_STRICT_LOOPBACK=1` rejects unauthenticated non-loopback calls end to end | The whole remote-MCP security model rests on this | 0.5 d |
| P6 | Graceful drain — `POST /api/admin/drain` that stops accepting jobs and resolves when the queue is idle | §3.5 step 2; prevents corrupt state on suspend | 1 d |
| P7 | Kill-switch Config rows — `pipeline.ocrEnabled`, `ingestion.enabled` | Enforce caps without stopping the container | 0.5 d |
| P8 | Remove port 3001 from the container/compose spec | Finding A: nothing listens there | 0.1 d |

**Total prerequisite work: ~7 days.**

---

## 10. Task plan

### Phase 0 — Decisions (before any code)

- [ ] **0.1** Domain: register `soundsuite.app` (~$20/yr) vs. buy Cloudflare ACM ($120/yr) for
      `*.app.soundsuite.ai`. *Recommendation: register the domain.*
- [ ] **0.2** Confirm plan limits in §8 are commercially acceptable.
- [ ] **0.3** Confirm v1 platform: Fly.io Machines — **accepting ~47% gross margin** (§7.1) in
      exchange for zero ops and fastest launch, with a planned migration to Option B at ~40
      tenants (§7.4). If 47% is not acceptable, go straight to Hetzner and add ~2 weeks of
      Phase 6 ingress work. Do not check this box on the assumption that scale-to-zero will
      rescue the margin: §2.3 forbids the duty cycle that would.
- [ ] **0.4** Legal: ToS, DPA, privacy policy covering litigation documents at rest. Non-trivial
      for this market — budget real time, and note that customer API keys are stored in the
      tenant database.

### Phase 1 — Prerequisites (~7 days)

- [ ] **1.1** P1–P8 from §9.
- [ ] **1.2** Publish `@soundsuite/mcp-bridge` to npm with bearer-token support.
- [ ] **1.3** Build and publish a hosted-profile image to GHCR with a pinned version tag.

### Phase 2 — Control plane, core (~12 days)

- [ ] **2.1** Scaffold Laravel 13 app, Postgres, queue/Horizon, deploy to `app.soundsuite.app`.
- [ ] **2.2** Auth: signup, login, password reset, email verification.
- [ ] **2.3** `Tenant` model + lifecycle state machine (§3.5) with an audit log table.
- [ ] **2.4** `TenantDriver` interface + `FlyDriver` (provision / start / stop / suspend /
      destroy / snapshot / usage).
- [ ] **2.5** Username validation, reserved-name list, uniqueness.
- [ ] **2.6** Provisioning job: create volume → create machine → poll `/api/health` → bootstrap
      admin → seed `pipeline.ocrProvider=local` → generate MCP key → mark active.
- [ ] **2.7** Deprovision job with the §3.5 ordering (drain → backup → R2 → verify → stop).

### Phase 3 — Billing (~6 days)

- [ ] **3.1** Stripe Cashier, products, $10 Starter + $29 Pro, 14-day trial.
- [ ] **3.2** Checkout session + success/cancel handling.
- [ ] **3.3** Webhook endpoint: signature verification, idempotency table, ordering guard.
- [ ] **3.4** All events from §5.2 wired to state transitions.
- [ ] **3.5** Billing portal link (Stripe-hosted — do not build card management).
- [ ] **3.6** Dunning emails: payment failed, grace expiring, suspended, data-deletion notice.

### Phase 4 — Data (~7 days)

- [ ] **4.1** Exhibit storage → R2 (P3), with per-tenant key prefixes and signed URLs.
- [ ] **4.2** Nightly export job → R2, 7 rolling copies.
- [ ] **4.3** Export page: on-demand export, signed download, works while suspended.
- [ ] **4.4** Import: upload, validate manifest, quota pre-check, path-traversal guard, restore.
- [ ] **4.5** Self-hosting guide (§6.3) published to `/docs`.
- [ ] **4.6** Retention jobs: purge volume at +30d, R2 at +90d, notice at +76d.

### Phase 5 — Quotas & metering (~5 days)

- [ ] **5.1** Consume `/api/metering` (P4); store time series per tenant.
- [ ] **5.2** XFS project quotas (or Fly volume size) + 15-min `du` sweep.
- [ ] **5.3** Enforcement: warn at 80%, warn at 95%, block at 100% via kill-switch rows (P7).
- [ ] **5.4** Usage display in the tenant dashboard.

### Phase 6 — Operations (~8 days)

- [ ] **6.1** Sleep/wake scheduler honouring the tenant's working hours (§2.3).
- [ ] **6.2** Wake-aware MCP bridge (§2.3 item 2).
- [ ] **6.3** Monitoring: per-tenant health, container restarts, disk, queue depth; alerting.
- [ ] **6.4** Rolling upgrade runbook: canary one tenant, then batches; `prisma migrate deploy`
      only, per `docs/roadmap-docker-mcp.md` §6 and `CLAUDE.md`'s database-safety rules.
- [ ] **6.5** Incident runbooks: stuck provision, failed migration, volume full, R2 outage.
- [ ] **6.6** Status page.

### Phase 7 — Marketing site (~3 days)

- [ ] **7.1** Update `content/collections/pages/pricing.md` + `pricing.antlers.html` with the
      §8 tiers and a CTA to `app.soundsuite.app/signup`.
- [ ] **7.2** "Hosted vs. self-hosted" comparison page.
- [ ] **7.3** Claude Desktop setup guide with copy-paste config.
- [ ] **7.4** Deploy via `scripts/private/deploy.sh` — and per `CLAUDE.md`, **never** add
      `vendor:publish --tag=statamic --force` to any deploy script.

### Phase 8 — Beta (~10 days elapsed)

- [ ] **8.1** Internal dogfood: 3 tenants, full lifecycle including suspend and export.
- [ ] **8.2** Restore-on-own-machine drill from a real export tarball.
- [ ] **8.3** **Set the real plan caps** (blocking for the pricing page). Benchmark local CPU
      PaddleOCR pages/hour/core on the target instance type, on a representative mix of scanned
      and native-text pages; measure cold start under load and peak RSS during ingestion. The
      §8 table is a placeholder until this task replaces it with measured numbers.
- [ ] **8.4** Security review: container escape surface, cross-tenant reachability, key handling.
- [ ] **8.5** Private beta, 10 external users, free.

**Total: ~48 engineering days ≈ 10 weeks for one person**, plus elapsed beta time.

---

## 11. Risks

| Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|
| OCR load from one tenant starves the node | High | **High** | Hard monthly cap, `JOB_CONCURRENCY=1`, low-priority queue, cgroup CPU limits |
| Storage growth outruns the $10 price | High | **High** | Hard quota, exhibits to R2, block-don't-bill |
| Cold start breaks MCP calls | Med | **High** | Working-hours warm window + wake-aware bridge (§2.3) |
| Container escape → cross-tenant data | **Critical** | Low | Per-tenant Redis, no Docker socket, cap-drop, read-only rootfs, encrypted volumes, security review |
| Customer API keys leak from a tenant DB | **Critical** | Low | Encrypted volumes, documented in privacy policy; consider moving keys to control-plane-held secrets in v2 |
| A migration fails mid-fleet | High | Med | Canary + batched rollout; `migrate deploy` only; pre-upgrade backup per roadmap §6 |
| Stripe webhook replay double-provisions | Med | Med | Idempotency table on `event.id` (§5.2) |
| Suspended customer can't export | High | Med | Export *before* stop (§3.5); test in Phase 8.1 |
| Statamic static cache serves stale pricing | Low | Med | `statamic:static:clear` already in `deploy.sh` — don't strip it |
| Litigation-data breach | **Critical** | Low | Encryption at rest, access logging, DPA, incident plan; this is a regulated-adjacent market |

---

## 12. Open questions

1. **Where do tenants' PDFs come from?** The hosted container has no `/watch/cases` bind mount,
   so upload-through-UI is assumed. Is a watched-folder sync (Dropbox/Drive/S3) needed at
   launch? It changes the ingestion story significantly.
2. **Is the 14-day trial card-required?** Card-required cuts abuse and cuts signups. For a
   resource-heavy product with per-tenant provisioning cost, card-required is the safer default.
3. **GPU OCR as a paid add-on?** A shared GPU host at ~$300/month breaks even at roughly 15
   tenants paying a $20 add-on. Worth modelling separately — do not fold it into $10.
4. **Team/multi-seat?** The app has a single `AdminUser` per install. Multiple seats per tenant
   means a real user table inside the app. Out of scope here; flag before promising it.
5. **Data residency.** Litigation documents may carry jurisdictional constraints. Fly and
   Hetzner both offer region pinning — confirm what the target market actually requires.

---

## 13. References

- `docs/roadmap-docker-mcp.md` — containerisation phases; multi-tenant SaaS is an explicit non-goal
- `docs/PostgressUpgradeV2.md` — the Postgres path, deferred; relevant if per-tenant SQLite becomes a ceiling
- `CLAUDE.md` → "Marketing Website (Statamic) Deployment" — deploy landmines that apply to Phase 7
- `CLAUDE.md` → "Database Safety" — why upgrades use `migrate deploy` only
- `Dockerfile`, `docker/entrypoint.sh`, `docker-compose.yml` — the container this builds on
- `scripts/manage.mjs` — `db:backup` / `db:restore`, the basis of §6
- `scripts/mcp-bridge/` — the client shim to publish in Task 1.2
