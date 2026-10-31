-- AlterTable: add `runtime` selector to HostRoleAssignment.
-- Defaults to 'docker-ollama'; app code rewrites pre-existing rows on the
-- darwin OS to 'host' on first read (see admin-role-assignments.tsx).
--
-- No-op now. Prisma sorts this folder name ("20260512_...") BEFORE
-- 20260512074731_role_registry, so on a fresh DB the old
--   ALTER TABLE "HostRoleAssignment" ADD COLUMN "runtime" TEXT DEFAULT 'docker-ollama';
-- ran before the table existed and failed. The column is now created in
-- 20260512080522_simplify_role_catalog. Existing DBs ran the old ALTER already.
SELECT 1;
