-- CreateTable: HostProvisioning — per-sidecar overrides for OS detection and
-- the master URL that THIS host should use to call HOME. Empty / NULL fields
-- fall back to the global Config DB / env-derived defaults.
CREATE TABLE IF NOT EXISTS "HostProvisioning" (
    "id" TEXT PRIMARY KEY NOT NULL,
    "sidecarUrl" TEXT NOT NULL,
    "hostOsOverride" TEXT,
    "masterUrlForHost" TEXT,
    "notes" TEXT,
    "updatedAt" DATETIME NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX IF NOT EXISTS "HostProvisioning_sidecarUrl_key" ON "HostProvisioning"("sidecarUrl");
CREATE INDEX IF NOT EXISTS "HostProvisioning_sidecarUrl_idx" ON "HostProvisioning"("sidecarUrl");
