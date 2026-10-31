-- CreateTable
CREATE TABLE "SidecarCommand" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sidecarUrl" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "payload" TEXT NOT NULL DEFAULT '{}',
    "status" TEXT NOT NULL DEFAULT 'pending',
    "result" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "expiresAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "SidecarCommand_sidecarUrl_status_idx" ON "SidecarCommand"("sidecarUrl", "status");

-- CreateIndex
CREATE INDEX "SidecarCommand_status_expiresAt_idx" ON "SidecarCommand"("status", "expiresAt");
