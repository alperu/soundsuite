# Case-File Ingestion in Docker — Upload + Cloud Connectors — Design Spec

> **Status:** Design. No code in this document — it specifies a phased plan only.
> **Related:** [`roadmap-docker-mcp.md`](./roadmap-docker-mcp.md) (§3 data-dir discipline, §4 Phase 1 containerization, §7/Phase 4 Docker Desktop Secrets Engine, §10 known risks) and [`SPEC-runpod-overflow.md`](./SPEC-runpod-overflow.md) (cloud/remote deploy context).

---

## 1. Problem

Today a **Case is a watched host directory**. The whole ingestion chain is anchored on a real folder path that exists on the machine running the app:

- `Case.path` is a non-null, `@unique` column (`prisma/schema.prisma:18`). A Case *is* a directory path.
- `FileWatcher.ensureCaseRecords()` upserts exactly one Case per entry in `WATCH_PATHS`, deriving `name = path.basename(watchPath)` (`src/services/file-watcher.ts:136-148`). Cases are literally born from host directories.
- `FileWatcher.findCaseForFile()` maps a discovered file to its Case purely by prefix: `filePath.startsWith(watchPath)` (`src/services/file-watcher.ts:390-393`).
- `WATCH_PATHS` is read from the environment (`src/app/api/admin/watch-paths/route.ts:20`); the container default is `/watch/cases`, fed by a bind mount `~/Documents/Cases → /watch/cases` (roadmap §4 topology + env table).
- Even the **existing** upload route assumes `Case.path` is a writable host directory — it writes uploaded PDFs to `path.join(caseRecord.path, '__uploads')` (`src/app/api/cases/[id]/upload/route.ts:52`).

**The chain that breaks in Docker:** no host dir → no `WATCH_PATHS` entry → no Case born from it → and the upload target `Case.path/__uploads` points at a path that does not exist in the container.

Three concrete failure modes for a pulled / cloud-hosted image:

1. **No host folder to bind-mount.** A user who runs `docker run soundsuite/app` (or a hosted instance per `SPEC-runpod-overflow.md`) has no `~/Documents/Cases` wired into the container. `WATCH_PATHS=/watch/cases` resolves to an empty (or absent) directory, so no Cases and no Documents are ever created.
2. **Remote users can't drop files on the server.** When the app runs on a remote host, "copy a PDF into a folder" is not an option — the only ingress is the HTTP surface (the UI / API).
3. **Bind-mount performance is poor on Mac/Windows** (roadmap §10): VirtioFS / gRPC-FUSE make a host-mounted watch path slow and chokidar-polling-heavy. Even where a bind mount *is* possible, it is the discouraged path.

Therefore case files must be able to enter the system through **HTTP upload** and **cloud-storage sync**, landing on the app's own **named volume** (`soundsuite-data → /data/v1`, roadmap §3/§4) and then flowing through the **existing, unchanged** ingestion pipeline.

---

## 2. Current ingestion model (what's reusable vs. what assumes a local dir)

```
WATCH_PATHS (env)
  → FileWatcher (chokidar)              src/services/file-watcher.ts
      • computeFileHash → SHA-256
      • dedup by Document.hash @unique
      • findCaseForFile (startsWith)
      • create Document(status: DISCOVERED)   ← NOT QUEUED (see note)
  → (user "files" the document via UI)
  → Document(status: QUEUED)
  → JobQueue / ParsingWorkerManager     src/services/job-queue.ts
  → IngestionPipeline (14 stages)       src/lib/ingestion/ingestion-pipeline.ts
      QUEUED → PROCESSING → INDEXED (or ERROR)
  → LanceDB + SQLite
```

| Component | Reusable as-is in Docker? | Why |
|-----------|---------------------------|-----|
| `IngestionPipeline` (14 stages) | **Yes, unchanged** | Operates on a `(documentId, filePath)` pair. It does not care *how* the file arrived — only that the bytes are on a path it can read. This is the load-bearing reuse: every ingress option below ends by producing a `Document` row pointing at a file on the volume. |
| `JobQueue` / `ParsingWorkerManager` | **Yes, unchanged** | Consumes `QUEUED` Documents from Prisma. Source-agnostic. |
| SHA-256 hashing + `Document.hash @unique` dedup | **Yes, reuse** | Already used by both FileWatcher (`file-watcher.ts:170-180`) and the upload route (`upload/route.ts:76,80`). Becomes the cross-source / re-sync dedup mechanism (§9). |
| `FileWatcher` (chokidar) | **Partly** | The mechanism (hash → dedup → create Document) is fine, but it assumes `WATCH_PATHS` are real host directories and that `Case.path` is a prefix of each file. For Docker we keep it pointed at the volume-internal cases dir (§6), not at a bind mount. |
| `Case.path` semantics | **Must change** | `@unique`, non-null, and assumed to be a writable host directory by `ensureCaseRecords` and the upload route. See §5. |

> **Status note (DISCOVERED vs QUEUED).** The code paths disagree, and this is a real design fork, not a detail:
> - `FileWatcher` creates documents as **`DISCOVERED`** — "documents are NOT automatically queued… they only transition to QUEUED when a user explicitly files them through the UI" (`file-watcher.ts:199-209`).
> - The **upload route** creates documents directly as **`QUEUED`** and immediately kicks the worker (`upload/route.ts:124,140`).
>
> (The CLAUDE.md summary saying FileWatcher "creates QUEUED" is stale relative to the source.) The spec adopts an explicit, per-source **status policy** — see §5.

---

## 3. Option A — Direct upload into the volume

**Upload is already partially implemented.** `POST /api/cases/[id]/upload` (`src/app/api/cases/[id]/upload/route.ts`) accepts multipart `file` entries, enforces a **200 MB** per-file cap (`upload/route.ts:8`), computes **SHA-256** and dedupes against `Document.hash` (`upload/route.ts:76,80`), writes the file, creates a `QUEUED` Document, and kicks the worker (`upload/route.ts:115-141`). So several of the requirements below are *already satisfied* — this section designs only the **delta** needed for Docker plus the genuinely-missing large-file features.

### A.1 The load-bearing fix: repoint the write target onto the named volume

Today the route writes to `path.join(caseRecord.path, '__uploads')` (`upload/route.ts:52`). In a pulled container `Case.path` is not a writable host directory — **this is exactly what breaks**.

**Change:** uploads (and all non-`local-dir` sources) write into a volume-internal, per-case directory:

```
${SOUND_SUITE_DATA_DIR}/v1/cases/<caseId>/<source>/<sanitized-filename>.pdf
```

- This lives on the persistent `soundsuite-data` named volume (roadmap §3), so it survives container removal and is not subject to bind-mount perf penalties (§10).
- `<caseId>` (not `Case.path`) becomes the directory key, which decouples disk layout from the legacy host-path semantics (see §5 for the schema change).
- `<source>` segment (`upload/`, `gdrive/`, `box/`, …) keeps provenance visible on disk and avoids cross-source name collisions.

### A.2 Drag-and-drop in the case-definition flow

- The case-create / case-detail UI gains a drag-drop dropzone bound to `POST /api/cases/[id]/upload` (multi-file, repeated `file` parts — already supported).
- For a **brand-new cloud case** (no host dir), case creation no longer requires a folder path; it provisions the `v1/cases/<caseId>/` directory server-side (§5) and the dropzone targets it.
- Show per-file rows with status: `queued`, `duplicate` (hash already present), `skipped` (non-PDF / oversize), `error`. The route already returns this shape (`upload/route.ts:159-164`).

### A.3 Large files, chunked uploads, resumability (the genuinely missing part)

The current route buffers the whole file in memory (`Buffer.from(await file.arrayBuffer())`, `upload/route.ts:75`) and caps at 200 MB. For large transcripts / exhibit-heavy PDFs and flaky remote links this is insufficient. Add a **chunked, resumable** upload protocol alongside the existing single-shot route:

| Concern | Design |
|---------|--------|
| Chunking | Client splits into fixed-size chunks (e.g. 8 MB). New endpoints: `POST /api/cases/[id]/upload/session` (begin → returns `uploadId`, expected total size, chunk size), `PUT /api/cases/[id]/upload/session/[uploadId]/[index]` (one chunk), `POST /api/cases/[id]/upload/session/[uploadId]/complete` (finalize). |
| Staging | Chunks written to `${SOUND_SUITE_DATA_DIR}/v1/cache/uploads/<uploadId>/` (the `cache/` area is already reserved, roadmap §3). On `complete`, concatenate → move into `v1/cases/<caseId>/upload/`. |
| Resumability | A `GET …/session/[uploadId]` returns the set of received chunk indexes so a reconnecting client resumes from the gap. Stale sessions are GC'd from `cache/` after a TTL. |
| Dedup | SHA-256 computed **streamingly** during finalize (mirror `computeFileHash`'s `createReadStream` approach, `file-watcher.ts`), then the same `Document.hash @unique` check. Reuses existing dedup — no new mechanism. |
| Max size | Raise / make configurable (env `MAX_UPLOAD_BYTES`, default 200 MB to match `upload/route.ts:8`); chunking removes the in-memory ceiling. |
| Progress | Client computes progress from acked chunks; server emits a `document_added` SSE on finalize (the route already calls `publishDocumentEvent`, `upload/route.ts:129`). |

### A.4 Status policy for uploads

Keep the current behavior (`status: 'QUEUED'`, auto-ingest) as the **default for uploads** — a user dragging a file in is an explicit "ingest this" intent, unlike a passive folder scan. Make it overridable via a form flag (`autoQueue=false` → `DISCOVERED`) so the upload path can mirror the FileWatcher "discover, then file" workflow when desired.

---

## 4. Option B — Cloud-storage connectors

**Primary targets: Google Drive and Box.** Also in scope: Dropbox, OneDrive, and S3-compatible object storage (AWS S3 / MinIO). All connectors converge on the same final step: **fetch bytes → write into `v1/cases/<caseId>/<source>/` → create a `Document` row → existing pipeline runs unchanged.** The connector layer never touches the pipeline.

### B.1 Common connector model

```
src/lib/connectors/
  connector.ts            # ConnectorProvider interface (abstract)
  gdrive.ts  box.ts  dropbox.ts  onedrive.ts  s3.ts
```

A `ConnectorProvider` exposes a small surface:

| Capability | Description |
|------------|-------------|
| `getAuthUrl()` / `handleCallback(code)` | OAuth2 authorization-code flow (S3 uses static access keys instead of OAuth). |
| `listFolders(parentId?)` | Drives the folder-picker UI. |
| `listFiles(folderId, cursor?)` | Page through PDFs in the mapped folder. |
| `download(fileId) → stream` | Fetch bytes for one file; piped to disk + hashed streamingly. |
| `delta(folderId, sinceToken)` | Incremental change list for continuous sync (provider-native change cursor where available). |

### B.2 OAuth flow & token storage

- **Consent UI** lives in an admin connectors page (`/admin/connectors` or per-case "Connect a folder"). The flow: user clicks **Connect Google Drive** → redirect to provider consent → provider redirects back to `GET /api/connectors/gdrive/callback` → app exchanges `code` for access + refresh tokens.
- **Token store:** **Docker Desktop Secrets Engine** is the target token store (roadmap §7 / Phase 4, which retires `MCP_AUTH_MODE=apikey`/`oauth` in favor of it). Connector OAuth tokens are stored there as Docker secrets, **never** in the SQLite DB in plaintext and never in env/logs (§7). For dev / non-Docker-Desktop installs, fall back to encrypted-at-rest storage (§7).
- The `Connector` row (§5) holds only a **reference** to the secret (a secret name / handle), not the token material.

### B.3 Folder picker → Case mapping

- After consent, the user browses the connector's folder tree (`listFolders`) and selects a folder. That folder maps to a Case: a new Case is created (or an existing one chosen) with `sourceType` = the connector and the connector config recording the remote `folderId` (§5).
- The Case's on-disk staging dir is `v1/cases/<caseId>/<source>/`; fetched files land there and are ingested. The remote folder is the *source of truth*; the volume holds working copies the pipeline reads.

### B.4 One-time import vs. continuous sync

| Mode | Behavior |
|------|----------|
| **One-time import** | Enumerate the folder once (`listFiles` paged), download each PDF, dedup by hash, create Documents. Good for "ingest this archive once." |
| **Continuous sync** | A scheduled poller (per connector, see §6) periodically calls `delta()` (or re-`listFiles` + hash where no delta cursor exists) and pulls new/changed PDFs. **Polling is the default ingress** for self-hosted containers — webhooks/push require an inbound-reachable URL, which a container behind NAT typically lacks (§9). Webhook support is an optional enhancement for instances with a public callback URL. |

Sync cadence is configurable (e.g. every 5–15 min) and respects provider rate limits with backoff (§9). The existing FileWatcher already polls for network drives at a 5 s interval (`file-watcher.ts:49`); connector polling is the cloud analogue but driven by the connector API, not the filesystem.

### B.5 Provider notes

| Provider | Auth | Folder id | Delta / change feed | Notes |
|----------|------|-----------|---------------------|-------|
| **Google Drive** (primary) | OAuth2, scope `drive.readonly` | folder fileId | Changes API w/ page token | Watch for shared-drive vs. My Drive folder ids. |
| **Box** (primary) | OAuth2, read scope | folder id | Events API / polling | Enterprise sharing model; respect collaboration scope. |
| Dropbox | OAuth2, read scope | path / folder cursor | `list_folder/continue` cursor | Path-based; cursor gives cheap deltas. |
| OneDrive | OAuth2 (MS identity), `Files.Read` | item id | delta query | Personal vs. business tenants differ. |
| S3 / MinIO | Static access key + secret (no OAuth) | bucket + prefix | `ListObjectsV2` + ETag/last-modified | ETag ≈ content hash; good re-sync signal. MinIO is the self-hosted option. |

### B.6 Status policy for connector files

Connector-synced files default to **`DISCOVERED`** (mirroring FileWatcher's "discover, then the user files it" model, `file-watcher.ts:199-209`) — a bulk folder sync is a passive event, not an explicit per-file ingest intent. A per-connector "auto-queue on sync" toggle promotes them to `QUEUED`. This is a deliberate inversion of the upload default (§3.4) and is the key UX decision of this spec.

---

## 5. Data-model changes

The friction point is that `Case.path` is **`@unique` and non-null** (`schema.prisma:18`) and is assumed to be a writable host directory. We keep the column (local-dir dev must keep working) but redefine what it holds for non-local sources, and add source metadata.

### 5.1 `Case` gains a source descriptor

```
model Case {
  ...
  path        String  @unique          // KEPT. For local-dir = host dir.
                                        // For other sources = ${DATA_DIR}/v1/cases/<id>/
  sourceType  String  @default("local-dir")
                                        // local-dir | upload | gdrive | box | dropbox | onedrive | s3
  connectorId String?                  // FK → Connector (null for local-dir / upload)
  ...
}
```

- **`Case.path` for non-local sources** = `${SOUND_SUITE_DATA_DIR}/v1/cases/<caseId>/`. This preserves the `@unique` invariant and keeps `findCaseForFile`'s `startsWith` prefix logic working (§6) without rewriting it.
- **Chicken-and-egg:** the path needs the generated `caseId`, but `caseId` is assigned at insert. Resolve with a **two-step create**: insert the Case (Prisma generates the `uuid`), then update `path = ${DATA_DIR}/v1/cases/<id>/` and `mkdir -p` it. (Alternatively, generate the uuid app-side before insert.) Either way the layout is deterministic and unique.

### 5.2 New `Connector` model

```
model Connector {
  id          String   @id @default(uuid())
  type        String                       // gdrive | box | dropbox | onedrive | s3
  displayName String
  folderId    String?                      // mapped remote folder / bucket+prefix
  secretRef   String                       // handle into Docker Secrets / encrypted store — NEVER the token itself
  syncMode    String   @default("one-time")// one-time | continuous
  autoQueue   Boolean  @default(false)     // DISCOVERED vs QUEUED on sync (§4.6)
  syncCursor  String?                       // provider delta token / S3 marker
  lastSyncAt  DateTime?
  status      String   @default("idle")    // idle | syncing | error
  errorMessage String?
  cases       Case[]
  createdAt   DateTime @default(now())
  updatedAt   DateTime @updatedAt
}
```

No token material is ever stored in this row — only `secretRef` (§7).

### 5.3 `v1/cases/` layout addition (consistent with roadmap §3)

Extends the roadmap §3 versioned tree with a `cases/` sibling:

```
${SOUND_SUITE_DATA_DIR}/
└── v1/
    ├── db/          # sound-suite.db (+ .wal, .shm)   [roadmap §3]
    ├── lancedb/     # LanceDB fragments                [roadmap §3]
    ├── exhibits/    # extracted exhibit images          [roadmap §3]
    ├── backups/     # BackupManager output              [roadmap §3]
    ├── cache/       # page/OCR cache + upload staging    [roadmap §3; §3.3 here]
    └── cases/       # NEW — per-case ingested files on the volume
        └── <caseId>/
            ├── upload/   # Option A direct uploads
            ├── gdrive/   # connector-fetched files
            ├── box/
            └── ...
```

Because `cases/` is under the `v1/` layout-versioned root, it is covered by the existing layout-version gate and backup discipline (roadmap §3/§6) at no extra cost.

### 5.4 Migration & dev compatibility

- Schema change applied via `prisma migrate deploy` only (roadmap §6 Defense 3; CLAUDE.md DB-safety rules). Adds nullable / defaulted columns + a new table — additive, non-destructive.
- Existing local-dir Cases get `sourceType = "local-dir"` by default; their `path` is unchanged. `npm run dev` with `WATCH_PATHS` pointed at real folders behaves exactly as today.

---

## 6. How WATCH_PATHS / FileWatcher coexist

**Both ingress styles coexist; they target different roots.**

- **Desktop / dev (local-dir):** `WATCH_PATHS` keeps pointing at bind-mounted host folders (`~/Documents/Cases → /watch/cases`, roadmap §4). FileWatcher behaves exactly as today.
- **Cloud / pulled container:** there is no host bind mount. Uploads and connector syncs write into `${SOUND_SUITE_DATA_DIR}/v1/cases/<caseId>/`.

**Recommended approach — one unified watch root + direct enqueue, hybrid:**

1. Add the volume-internal cases dir to the watch set: effectively `WATCH_PATHS = /watch/cases (if mounted) + ${DATA_DIR}/v1/cases`. Because `Case.path` for non-local sources is `${DATA_DIR}/v1/cases/<caseId>/` (§5.1), `findCaseForFile`'s existing `startsWith` prefix match (`file-watcher.ts:390-393`) resolves uploaded/synced files to the right Case **with no change to that function**.
2. **But** prefer **direct enqueue** for the HTTP/connector paths: the upload route already creates the Document row itself rather than waiting for chokidar (`upload/route.ts:117`). This is more reliable than relying on filesystem-event delivery for a volume the app itself just wrote to, and avoids double-handling. The watcher on `v1/cases` is a **safety net** (catches files written out-of-band, e.g. a restore) rather than the primary trigger.

This keeps a single conceptual watch root while making the volume-internal sources self-enqueue. No per-source pipeline branches — everything funnels into the same `Document → QUEUED → JobQueue → IngestionPipeline` path.

---

## 7. Security & privacy

This is legal data; the deployment is single-user per the roadmap (multi-user auth is explicitly out of scope, roadmap §11). Security goals are about **token handling and data residency**, not RBAC.

- **OAuth scopes: read-only wherever the provider offers it** — `drive.readonly` (Google), read scope (Box/Dropbox), `Files.Read` (OneDrive). The app only ever pulls files; it never needs write/delete on the user's cloud.
- **Token storage:** access + refresh tokens go to the **Docker Desktop Secrets Engine** (roadmap §7). They are **never** persisted in SQLite, never in env vars, never in `Connector` rows (only a `secretRef`). Dev fallback: encrypt-at-rest with a key derived from a local secret, stored outside the DB. 
- **Never log tokens.** Connector code must redact `access_token` / `refresh_token` / `code` / client secret in all log lines and error messages. Add a logger redaction rule for these keys.
- **Encryption at rest:** the named volume holds working copies of legal PDFs; document that the volume should sit on an encrypted disk for production. Backups (roadmap §6) inherit the same sensitivity.
- **Data residency:** fetched files are **copied** into the container volume — operators should understand that connecting a cloud folder replicates that data into the Sound Suite instance. Surface this in the connect-consent UI.
- **Least-privilege callbacks:** OAuth `redirect_uri` is locked to the instance's own origin; reject mismatches. S3 keys should be scoped (IAM policy / MinIO policy) to the single bucket+prefix.
- **Upload validation:** keep the PDF-only + size checks (`upload/route.ts:66-72`); sanitize filenames (already done, `upload/route.ts:10-13`) to prevent path traversal into the volume.

---

## 8. Phased implementation plan + file inventory (design only)

Sequence: **upload-on-volume first, then Google Drive, then Box, then the rest.** Each phase ships independently and leaves the local-dir path untouched.

### Phase 0 — Schema + path foundation
*(prerequisite; depends on roadmap §3 data-dir discipline being in place)*

- `prisma/schema.prisma` — add `Case.sourceType`, `Case.connectorId`; add `Connector` model. Migration via `migrate deploy`.
- `src/lib/paths.ts` *(new or extend)* — helper resolving `${SOUND_SUITE_DATA_DIR}/v1/cases/<caseId>/<source>/`.
- Case-create flow — provision the volume dir + set `path` for non-local cases (two-step create, §5.1).

### Phase 1 — Upload on the volume (Option A)
- **Modify** `src/app/api/cases/[id]/upload/route.ts` — write to the volume cases dir instead of `Case.path/__uploads` (§3.1).
- **New** chunked/resumable endpoints under `src/app/api/cases/[id]/upload/session/...` (§3.3).
- **New** UI: drag-drop dropzone component in the case-definition / case-detail view; progress + per-file status; resumable client.

### Phase 2 — Connector abstraction + Google Drive
- **New** `src/lib/connectors/connector.ts` — `ConnectorProvider` interface (§4.1).
- **New** `src/lib/connectors/gdrive.ts`.
- **New** API routes: `src/app/api/connectors/gdrive/auth/route.ts`, `.../callback/route.ts`, `.../folders/route.ts`, `.../sync/route.ts`.
- **New** `src/lib/connectors/secret-store.ts` — abstraction over Docker Secrets (prod) / encrypted-at-rest (dev).
- **New** scheduler for continuous-sync polling (a service akin to FileWatcher's lifecycle, registered with the services-manager singleton).
- **New** UI: `/admin/connectors` consent + folder-picker + per-case mapping.

### Phase 3 — Box
- **New** `src/lib/connectors/box.ts` + `src/app/api/connectors/box/*` (same shape as gdrive). Reuses the abstraction, secret store, scheduler, and UI from Phase 2.

### Phase 4 — Dropbox, OneDrive, S3/MinIO
- **New** `src/lib/connectors/{dropbox,onedrive,s3}.ts` + matching `src/app/api/connectors/*` routes. S3 uses static-key auth instead of OAuth (§4.2).

### Cross-cutting
- **Modify** FileWatcher config wiring to include `${DATA_DIR}/v1/cases` as a safety-net watch root (§6).
- **Modify** logger to redact token keys (§7).

---

## 9. Open questions / risks

| Risk / question | Mitigation / stance |
|-----------------|---------------------|
| **Token refresh lifecycle** | Refresh tokens expire / get revoked; a long-idle self-hosted instance may find tokens dead. Sync runs must detect 401, attempt refresh, and on failure mark `Connector.status = error` + surface a re-consent prompt — never silently stall. |
| **Large libraries** | A folder with thousands of PDFs can overwhelm one-time import. Page through `listFiles`, throttle downloads, and enqueue Documents incrementally so the pipeline drains as files arrive. Consider a per-sync cap with continuation. |
| **Rate limits** | All providers rate-limit. Use exponential backoff + respect `Retry-After`; keep poll cadence conservative (5–15 min default). |
| **Webhook reachability behind NAT** | A self-hosted container typically has no inbound-reachable URL, so push/webhooks are unreliable. **Favor polling** as the default sync mechanism (§4.4); webhooks are an opt-in enhancement only for instances with a public callback. |
| **Dedup across re-syncs** | Re-listing a folder re-sees existing files. The existing `Document.hash @unique` check (`upload/route.ts:80`; `file-watcher.ts:173-180`) already makes re-fetched identical files no-ops. For changed files (same name, new content), the new hash creates a new Document — decide whether to supersede the prior version or keep both (proposed: keep both; provenance via the `source` dir). |
| **`Case.path` uniqueness friction** | Two-step create resolves the chicken-egg (§5.1); ensure failure mid-create (insert ok, mkdir fails) is cleaned up transactionally or reconciled on next boot. |
| **DISCOVERED vs QUEUED divergence** | The per-source status policy (§3.4 upload→QUEUED, §4.6 connector→DISCOVERED) is a deliberate UX decision; validate with the user before implementation as it changes how files appear in the dashboard. |
| **Bind-mount perf (roadmap §10)** | By moving uploads/sync onto the named volume, the Mac/Windows VirtioFS penalty is avoided for these ingress paths entirely; only legacy local-dir users on bind mounts retain the risk. |
| **Volume disk growth** | Connector imports copy cloud data onto the volume; large libraries can fill it. Surface volume usage; consider a retention/cleanup policy for staged chunks in `cache/` and (optionally) for working copies after successful indexing. |
