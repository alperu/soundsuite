#!/bin/sh
###############################################################################
# Sound Suite container entrypoint
#
# Phase 1 scope (roadmap §4): keep this MINIMAL.
#   1. Ensure the versioned data-dir layout exists.
#   2. Run `prisma migrate deploy` (NEVER `dev`/`reset`).
#   3. exec the standalone Next.js server.
#
# The full safe-upgrade handshake (roadmap §6) is intentionally NOT implemented
# here yet — see the clearly-marked TODO block below. The data-dir layout and
# the absolute DATABASE_URL are already wired so those defenses can be layered
# on without changing the on-disk shape.
###############################################################################
set -eu

DATA_DIR="${SOUND_SUITE_DATA_DIR:-/data}"
LAYOUT_VERSION="${LAYOUT_VERSION:-1}"
V_DIR="${DATA_DIR}/v${LAYOUT_VERSION}"

log() { echo "[entrypoint] $*"; }

# --- 1. Ensure versioned data-dir layout (roadmap §3) ------------------------
# SQLite / LanceDB / BackupManager do NOT create missing parent dirs, so this
# must run before any migrate or query.
log "Ensuring data layout under ${V_DIR}"
for sub in db lancedb exhibits backups cache; do
  mkdir -p "${V_DIR}/${sub}"
done

###############################################################################
# TODO (roadmap §6 — Safe upgrade mechanics, deferred to a follow-up task):
#
#   Defense 1  Pre-migration backup via BackupManager, tagged
#              pre-upgrade-<from>-to-<to>-<ts>, with 5-latest / 30-day retention.
#   Defense 2  app_version handshake: read Config.app_version; refuse to start
#              if data version > image APP_VERSION (block accidental downgrade).
#   Defense 3  Hard-fail if MIGRATION_MODE=dev (deploy-only is already enforced
#              below by construction).
#   Defense 4  Layout-version gate: read highest vN/ present; if N > LAYOUT_VERSION
#              refuse; if N < LAYOUT_VERSION run scripts/migrate-layout-vN-to-vN+1.sh.
#   Escape hatch  CONFIRM_DESTRUCTIVE_UPGRADE=1 required for [DESTRUCTIVE UPGRADE]
#              releases; print CHANGELOG notes and exit otherwise.
#   Stamp      Write Config.app_version + Config.schema_version after a clean
#              migrate.
#
# These require app-source support (BackupManager invocation hook, Config-table
# reads from a shell context) and belong with the §3 path-unification work.
###############################################################################

# --- 2. Apply schema migrations (deploy only — never dev/reset) ---------------
# Guard: refuse any caller-supplied attempt to run dev/reset migrations.
if [ "${MIGRATION_MODE:-deploy}" != "deploy" ]; then
  log "FATAL: MIGRATION_MODE=${MIGRATION_MODE} is not allowed. Only 'deploy' is permitted."
  log "       prisma migrate dev/reset can wipe the database (see CLAUDE.md)."
  exit 1
fi

log "Applying migrations: prisma migrate deploy"
# prisma.config.ts supplies the datasource URL from DATABASE_URL.
npx prisma migrate deploy

# --- 3. Start the app --------------------------------------------------------
log "Starting Sound Suite (APP_VERSION=${APP_VERSION:-dev}) on ${HOSTNAME:-0.0.0.0}:${PORT:-3000}"
exec "$@"
