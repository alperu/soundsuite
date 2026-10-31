-- Simplify role catalog: drop RoleType CRUD, key HostRoleAssignment by mode.
--
-- Translates existing HostRoleAssignment.roleTypeId -> mode via RoleType.name
-- (prefixed with "ss-") BEFORE dropping the RoleType table. Rows whose
-- RoleType has no canonical mode equivalent (e.g. `cuda` utility, or
-- operator-created custom names) are deleted.

PRAGMA foreign_keys=OFF;
PRAGMA defer_foreign_keys=ON;

-- 1) Build new HostRoleAssignment table keyed by `mode`.
CREATE TABLE "new_HostRoleAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sidecarUrl" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minOnline" INTEGER NOT NULL DEFAULT 0,
    "idleTimeoutMin" INTEGER NOT NULL DEFAULT 5,
    "modelOverride" TEXT,
    -- Moved here from 20260512_add_role_assignment_runtime: Prisma sorts that
    -- folder name BEFORE this one, so on a fresh DB its ALTER ran before
    -- HostRoleAssignment existed. DBs that already ran both are unchanged.
    "runtime" TEXT DEFAULT 'docker-ollama',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- 2) Translate roleTypeId -> mode via "ss-" || RoleType.name. Filter to the
--    four canonical modes so we don't carry over `cuda` (utility) or any
--    operator-created custom role names.
INSERT INTO "new_HostRoleAssignment"
    ("id", "sidecarUrl", "mode", "enabled", "minOnline", "idleTimeoutMin", "modelOverride", "createdAt", "updatedAt")
SELECT
    hra."id",
    hra."sidecarUrl",
    'ss-' || rt."name" AS "mode",
    hra."enabled",
    hra."minOnline",
    hra."idleTimeoutMin",
    hra."modelOverride",
    hra."createdAt",
    hra."updatedAt"
FROM "HostRoleAssignment" hra
JOIN "RoleType" rt ON rt."id" = hra."roleTypeId"
WHERE ('ss-' || rt."name") IN ('ss-embedding', 'ss-completion', 'ss-ocr', 'ss-reranker');

-- 3) Swap tables.
DROP TABLE "HostRoleAssignment";
ALTER TABLE "new_HostRoleAssignment" RENAME TO "HostRoleAssignment";
CREATE INDEX "HostRoleAssignment_sidecarUrl_idx" ON "HostRoleAssignment"("sidecarUrl");
CREATE UNIQUE INDEX "HostRoleAssignment_sidecarUrl_mode_key" ON "HostRoleAssignment"("sidecarUrl", "mode");

-- 4) Drop the now-unused RoleType table.
DROP INDEX IF EXISTS "RoleType_name_key";
DROP TABLE "RoleType";

PRAGMA defer_foreign_keys=OFF;
PRAGMA foreign_keys=ON;
