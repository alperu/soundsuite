#!/usr/bin/env bash
#
# Sound Suite — full backup (source + database + vectors)
#
# Produces a single timestamped 7z archive containing:
#   - All source code (src/, sideCar/src/, scripts/, public/docs/, public/sideCar/, .claude/, docs/)
#   - Prisma schema + migrations
#   - The live SQLite database (prisma/data/sound-suite.db)
#   - The full LanceDB vector store (data/lancedb/)
#   - package.json + lockfiles (so a restore can `npm ci` to the exact dep tree)
#
# Excludes everything that's regenerable, gitignored junk, or huge churn:
#   - node_modules/, .next/, sideCar/.next/, sideCar/node_modules/
#   - .git/ (git is its own backup; the source tree IS in here)
#   - public/exhibits/ (extracted from PDFs on demand)
#   - public/sideCar/builds/ (sidecar release tarballs — re-buildable)
#   - logs/, .pids/, .DS_Store
#   - marketing/website/src/vendor/ + storage/ (Composer / Statamic caches, gigabytes)
#
# Destination: Google Drive desktop mount (same folder the per-commit hook uses).
# Naming: court-lens-mcp_FULL_<timestamp>_commit<N>_<sha>.7z
# Retention: keeps the last 5 FULL backups; older ones are deleted.
#
# Usage:
#   scripts/full-backup.sh                    # default — stops services, backs up, restarts
#   scripts/full-backup.sh --no-stop          # do NOT stop/restart services (caller is responsible)
#   scripts/full-backup.sh --dest /custom/dir # write archive elsewhere instead of Google Drive
#   scripts/full-backup.sh --dry-run          # show what would be archived; don't write the archive
#
# Exits non-zero on any failure. Designed to be run before destructive operations
# (Prisma upgrades, schema changes, big refactors).

set -euo pipefail

# ─── Config ─────────────────────────────────────────────────────────────────

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PROJECT_NAME="$(basename "$PROJECT_DIR")"
DEFAULT_DEST="/Users/alper/Library/CloudStorage/GoogleDrive-alper@basservices.net/My Drive/Backups/code"
RETAIN_COUNT=5

# ─── Args ───────────────────────────────────────────────────────────────────

STOP_SERVICES=1
DRY_RUN=0
DEST="$DEFAULT_DEST"

while [ $# -gt 0 ]; do
  case "$1" in
    --no-stop) STOP_SERVICES=0; shift ;;
    --dest) DEST="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "[ERROR] Unknown arg: $1" >&2; exit 2 ;;
  esac
done

# ─── Pre-flight ─────────────────────────────────────────────────────────────

cd "$PROJECT_DIR"

if ! command -v 7z &>/dev/null; then
  echo "[ERROR] 7z not found in PATH. Install with: brew install p7zip" >&2
  exit 1
fi

if [ ! -d "$DEST" ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "[INFO] Destination does not exist — creating: $DEST"
  mkdir -p "$DEST"
fi

# ─── Stop services for a consistent SQLite snapshot ─────────────────────────
# (skipped in dry-run mode — we don't actually need a quiescent DB to print
# what *would* be archived, and stopping/restarting wastes ~30s)

if [ "$STOP_SERVICES" -eq 1 ] && [ "$DRY_RUN" -eq 0 ]; then
  echo "[1/4] Stopping services for a consistent snapshot..."
  if [ -x "$PROJECT_DIR/scripts/stop.sh" ]; then
    "$PROJECT_DIR/scripts/stop.sh" 2>&1 | sed 's/^/        /' || true
  else
    npm run svc:stop 2>&1 | sed 's/^/        /' || true
  fi
elif [ "$DRY_RUN" -eq 1 ]; then
  echo "[1/4] Dry run — leaving services running"
else
  echo "[1/4] Skipping service stop (--no-stop)"
fi

# ─── Build archive name ─────────────────────────────────────────────────────

TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
COMMIT_NUM="$(git rev-list --count HEAD 2>/dev/null || echo 0)"
COMMIT_SHORT="$(git rev-parse --short HEAD 2>/dev/null || echo unknown)"
ARCHIVE_NAME="${PROJECT_NAME}_FULL_${TIMESTAMP}_commit${COMMIT_NUM}_${COMMIT_SHORT}.7z"
ARCHIVE_PATH="$DEST/$ARCHIVE_NAME"

echo "[2/4] Computing payload size..."
# Best-effort size estimate (du is fast on APFS; if it slows things down we can
# drop this and just print the archive size at the end).
PAYLOAD_PATHS=(
  "src" "sideCar/src" "scripts" "public/docs" "public/sideCar"
  ".claude" "docs"
  "prisma/schema.prisma" "prisma/migrations" "prisma/data"
  "data/lancedb"
  "package.json" "package-lock.json"
  "next.config.ts" "tsconfig.json" "tailwind.config.ts" "postcss.config.mjs"
  ".env.example" "CLAUDE.md" "README.md"
)

EXISTING_PATHS=()
for p in "${PAYLOAD_PATHS[@]}"; do
  [ -e "$PROJECT_DIR/$p" ] && EXISTING_PATHS+=("$p")
done

if [ "${#EXISTING_PATHS[@]}" -eq 0 ]; then
  echo "[ERROR] No payload paths found. Are you running from a non-project dir?" >&2
  exit 1
fi

PAYLOAD_SIZE=$(du -sh -- "${EXISTING_PATHS[@]}" 2>/dev/null | awk '{sum+=$1} END {print sum}')
echo "        Source + data tree: ~${PAYLOAD_SIZE}M (pre-compression estimate)"

# ─── Dry run ────────────────────────────────────────────────────────────────

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[3/4] DRY RUN — would create:"
  echo "        $ARCHIVE_PATH"
  echo ""
  echo "        Including:"
  for p in "${EXISTING_PATHS[@]}"; do echo "          + $p"; done
  echo ""
  echo "        Excluding (via -xr! patterns):"
  cat <<'EOF'
          - node_modules
          - .next
          - sideCar/.next
          - sideCar/node_modules
          - .git
          - public/exhibits
          - public/sideCar/builds
          - logs
          - .pids
          - marketing/website/src/vendor
          - marketing/website/src/storage
          - .DS_Store
          - sound-suite.db-journal / -wal / -shm (SQLite write-ahead artifacts)
EOF
  echo "[4/4] Dry run — services left untouched"
  exit 0
fi

# ─── Build the archive ──────────────────────────────────────────────────────

echo "[3/4] Building 7z archive: $ARCHIVE_NAME"
echo "        Destination: $DEST"
START_MS=$(date +%s)

# -mx=5 = balanced compression (default; -mx=9 is much slower for ~10% smaller)
# -ms=on = solid mode (better ratio for many small files)
# -bd = no progress on stderr (cleaner log output)
# -mmt = use all CPU cores for compression
# 7z exits non-zero on any error; set -e propagates.
7z a -mx=5 -ms=on -bd -mmt=on \
  -xr!node_modules \
  -xr!.next \
  -xr!.git \
  -xr!public/exhibits \
  -xr!public/sideCar/builds \
  -xr!logs \
  -xr!.pids \
  -xr!marketing/website/src/vendor \
  -xr!marketing/website/src/storage \
  -xr!.DS_Store \
  -xr!sound-suite.db-journal \
  -xr!sound-suite.db-wal \
  -xr!sound-suite.db-shm \
  "$ARCHIVE_PATH" \
  "${EXISTING_PATHS[@]}" \
  | tail -5 | sed 's/^/        /'

ELAPSED=$(( $(date +%s) - START_MS ))
ARCHIVE_SIZE_HUMAN=$(du -h "$ARCHIVE_PATH" | awk '{print $1}')
ARCHIVE_SHA256=$(shasum -a 256 "$ARCHIVE_PATH" | awk '{print $1}')

echo ""
echo "        ✓ Archive built in ${ELAPSED}s"
echo "        ✓ Size:    $ARCHIVE_SIZE_HUMAN"
echo "        ✓ SHA-256: $ARCHIVE_SHA256"
echo "        ✓ Path:    $ARCHIVE_PATH"

# ─── Retention — keep last N FULL backups ───────────────────────────────────

ls -1t "$DEST"/${PROJECT_NAME}_FULL_*.7z 2>/dev/null | tail -n +$((RETAIN_COUNT + 1)) | while read -r old; do
  echo "        Pruning old FULL backup: $(basename "$old")"
  rm -f "$old"
done

# ─── Restart services ───────────────────────────────────────────────────────

if [ "$STOP_SERVICES" -eq 1 ]; then
  echo "[4/4] Restarting services..."
  if [ -x "$PROJECT_DIR/scripts/start.sh" ]; then
    "$PROJECT_DIR/scripts/start.sh" 2>&1 | sed 's/^/        /' || true
  else
    npm run svc:start 2>&1 | sed 's/^/        /' || true
  fi
else
  echo "[4/4] Leaving services as-is (--no-stop)"
fi

echo ""
echo "Done. To restore on a fresh machine:"
echo "  7z x \"$ARCHIVE_PATH\""
echo "  cd $PROJECT_NAME && npm ci && npx prisma generate"
