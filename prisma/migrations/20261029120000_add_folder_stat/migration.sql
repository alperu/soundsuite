-- Folder totals from file-system sidecars (fileSystemSideCar `folder-status`
-- profile). Purely additive: no existing table is touched.

-- CreateTable
CREATE TABLE "FolderStat" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sidecarId" TEXT NOT NULL,
    "root" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "caseId" TEXT,
    "fileCount" INTEGER NOT NULL DEFAULT 0,
    "totalBytes" BIGINT NOT NULL DEFAULT 0,
    "latestMtimeNs" BIGINT NOT NULL DEFAULT 0,
    "dirCount" INTEGER NOT NULL DEFAULT 0,
    "recFileCount" INTEGER NOT NULL DEFAULT 0,
    "recTotalBytes" BIGINT NOT NULL DEFAULT 0,
    "recLatestMtimeNs" BIGINT NOT NULL DEFAULT 0,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE UNIQUE INDEX "FolderStat_sidecarId_root_path_key" ON "FolderStat"("sidecarId", "root", "path");

-- CreateIndex
CREATE INDEX "FolderStat_caseId_idx" ON "FolderStat"("caseId");
