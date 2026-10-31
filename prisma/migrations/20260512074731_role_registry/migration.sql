-- CreateTable
CREATE TABLE "RoleType" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "image" TEXT NOT NULL,
    "model" TEXT,
    "port" INTEGER NOT NULL,
    "vram" INTEGER NOT NULL,
    "modes" TEXT NOT NULL,
    "gpuOnly" BOOLEAN NOT NULL DEFAULT false,
    "priority" TEXT NOT NULL DEFAULT 'normal',
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "HostRoleAssignment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "sidecarUrl" TEXT NOT NULL,
    "roleTypeId" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "minOnline" INTEGER NOT NULL DEFAULT 0,
    "idleTimeoutMin" INTEGER NOT NULL DEFAULT 5,
    "modelOverride" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "HostRoleAssignment_roleTypeId_fkey" FOREIGN KEY ("roleTypeId") REFERENCES "RoleType" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE UNIQUE INDEX "RoleType_name_key" ON "RoleType"("name");

-- CreateIndex
CREATE INDEX "HostRoleAssignment_sidecarUrl_idx" ON "HostRoleAssignment"("sidecarUrl");

-- CreateIndex
CREATE UNIQUE INDEX "HostRoleAssignment_sidecarUrl_roleTypeId_key" ON "HostRoleAssignment"("sidecarUrl", "roleTypeId");
