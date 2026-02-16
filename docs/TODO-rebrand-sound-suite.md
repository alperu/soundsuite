# TODO: Rebrand "Legal Lens" → "Sound Suite"

**Domain**: soundsuite.ai
**Date**: 2026-02-21

## Naming Map

| Context | Old | New |
|---------|-----|-----|
| Display name | Legal Lens | Sound Suite |
| Package slug | legal-lens | sound-suite |
| DB filename | legal-lens.db | sound-suite.db |
| Container prefix | ll- | ss- |
| Docker agent name | legal-lens-agent | sound-suite-agent |
| System identifier | Legal_Lens_System | Sound_Suite_System |

## Checklist

### 1. Database (do first — back up!)
- [ ] `cp prisma/data/legal-lens.db prisma/data/legal-lens.db.bak`
- [ ] `mv prisma/data/legal-lens.db prisma/data/sound-suite.db`
- [ ] `.env:2` — `legal-lens.db` → `sound-suite.db`

### 2. Package Names
- [ ] `package.json:2` — `"legal-lens"` → `"sound-suite"`
- [ ] `sideCar/package.json:2` — `"legal-lens-sidecar"` → `"sound-suite-sidecar"`

### 3. User-Visible UI
- [ ] `src/app/layout.tsx:6` — title `'Legal Lens'` → `'Sound Suite'`
- [ ] `src/components/navigation.tsx:25` — nav logo `Legal Lens` → `Sound Suite`
- [ ] `src/components/case-view-wrapper.tsx:80` — heading `Legal Lens` → `Sound Suite`
- [ ] `sideCar/src/app/layout.tsx:5` — `'Legal Lens GPU Orchestrator'` → `'Sound Suite GPU Orchestrator'`
- [ ] `sideCar/src/app/page.tsx:182` — h1 same

### 4. Container Prefix (ll- → ss-)
- [ ] `sideCar/src/lib/state.ts:3` — `CONTAINER_PREFIX = 'll-'` → `'ss-'`
- [ ] `sideCar/src/lib/gpu.ts:14,27,28` — `ll-gpu-probe` → `ss-gpu-probe`

### 5. SideCar Docker Scripts
- [ ] `sideCar/scripts/start-docker-agent.sh:2,12` — comment + `AGENT_NAME="legal-lens-agent"` → `"sound-suite-agent"`
- [ ] `sideCar/scripts/start-docker-agent.bat:2,10` — same for Windows

### 6. Shell Scripts (scripts/)
- [ ] `scripts/start.sh` — 4 occurrences
- [ ] `scripts/stop.sh` — 4 occurrences
- [ ] `scripts/health-check.sh` — 3 occurrences
- [ ] `scripts/restart.sh` — 3 occurrences
- [ ] `scripts/test/test-exhibits.sh` — 1 occurrence
- [ ] `scripts/test/test-all.sh` — 2 occurrences
- [ ] `scripts/test/test-mcp-tools.sh` — 1 occurrence
- [ ] `scripts/test/test-auth.sh` — 1 occurrence
- [ ] `scripts/test/test-ingestion.sh` — 4 occurrences (includes `legal-lens.db` path)
- [ ] `scripts/test/test-search.sh` — 1 occurrence
- [ ] `scripts/db/db-backup.sh` — 5 occurrences (includes `legal-lens.db` filename)
- [ ] `scripts/db/db-restore.sh` — 4 occurrences (includes `legal-lens.db` filename)
- [ ] `scripts/db/db-seed.sh` — 2 occurrences
- [ ] `scripts/db/db-migrate.sh` — 2 occurrences

### 7. Source Code (non-UI)
- [ ] `src/lib/logger.ts:2,33` — comments
- [ ] `src/lib/indexed-db.ts:2` — comment
- [ ] `src/lib/backup/index.ts:4` — comment
- [ ] `src/lib/backup/backup-manager.ts:4,93,281` — comments + `'legal-lens.db'` filename strings
- [ ] `src/lib/ingestion/claude-embedding-provider.ts:112` — error message
- [ ] `src/app/api/backup/route.ts:17` — `'./data/legal-lens.db'` fallback path

### 8. Test Files
- [ ] `src/app/api/backup/__tests__/backup.test.ts:166,174` — `legal-lens.db` paths
- [ ] `src/lib/backup/__tests__/backup-manager.test.ts:35` — test DB path
- [ ] `src/lib/ingestion/__tests__/ingestion-e2e.test.ts:120` — "Legal Lens" string

### 9. Documentation
- [ ] `README.md` — 5 occurrences
- [ ] `SETUP.md` — 4 occurrences
- [ ] `CLAUDE.md` — 4 occurrences
- [ ] `scripts/README.md` — 11 occurrences
- [ ] `src/lib/backup/README.md` — 7 occurrences
- [ ] `src/lib/LOGGER.md` — 3 occurrences
- [ ] `src/lib/mcp/README.md` — 3 occurrences
- [ ] `src/lib/ingestion/README.md` — 1 occurrence
- [ ] `src/lib/ingestion/INGESTION_PIPELINE.md` — 1 occurrence
- [ ] `src/lib/ingestion/TRANSFORMERS_PROVIDER.md` — 1 occurrence
- [ ] `src/lib/ingestion/CLAUDE_PROVIDER.md` — 7 occurrences
- [ ] `src/lib/ingestion/OPENAI_PROVIDER.md` — 1 occurrence
- [ ] `src/services/README.md` — 1 occurrence
- [ ] `src/services/job-queue.md` — 1 occurrence
- [ ] `src/components/__tests__/processing-progress.md` — 1 occurrence
- [ ] `src/components/search-interface.md` — 1 occurrence
- [ ] `docs/vllm-reranker-setup.md` — 8 occurrences
- [ ] `docs/ollama-setup.md` — 4 occurrences
- [ ] `docs/research-turso-concurrent-writes.md` — 1 occurrence

### 10. Claude Code Memory
- [ ] `.claude/projects/-Users-alper-Code-court-lens-mcp/memory/MEMORY.md` — update references

## Excluded (no change needed)
- `.kiro/specs/legal-lens/` — historical specs
- `sideCar/.next/` — build artifacts (regenerated)
- `sideCar/node_modules/`, `sideCar/package-lock.json` — regenerated on `npm install`

## Verification
- [ ] `npm run build` — no errors
- [ ] `npm run dev` — "Sound Suite" branding visible
- [ ] DB connects via Prisma to `sound-suite.db`
- [ ] `grep -ri "legal.lens" src/ scripts/ --include='*.ts' --include='*.tsx' --include='*.sh' --include='*.json'` — 0 results (excluding .kiro/)