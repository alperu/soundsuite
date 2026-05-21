-- Add first-class case-level record entities: ClerksRecord and ReportersRecord.
--
-- These represent appellate-level filing types that don't naturally belong to
-- a Motion (the Clerk's Record is the trial-court paper compilation; the
-- Reporter's Record is the court reporter's transcript volumes). Modeled as
-- their own tables so the tag panel can edit them directly via the Haystack
-- read/commit ops, rather than forcing them through MotionAttachment which
-- requires a motionId.

-- CreateTable
CREATE TABLE "ClerksRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "volume" INTEGER,
    "filedOn" DATETIME,
    "documentId" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ClerksRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ClerksRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "ReportersRecord" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "reporterId" TEXT,
    "volume" INTEGER,
    "hearingDate" DATETIME,
    "documentId" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "ReportersRecord_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "ReportersRecord_reporterId_fkey" FOREIGN KEY ("reporterId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "ReportersRecord_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "ClerksRecord_caseId_idx" ON "ClerksRecord"("caseId");

-- CreateIndex
CREATE INDEX "ClerksRecord_documentId_idx" ON "ClerksRecord"("documentId");

-- CreateIndex
CREATE INDEX "ReportersRecord_caseId_idx" ON "ReportersRecord"("caseId");

-- CreateIndex
CREATE INDEX "ReportersRecord_reporterId_idx" ON "ReportersRecord"("reporterId");

-- CreateIndex
CREATE INDEX "ReportersRecord_documentId_idx" ON "ReportersRecord"("documentId");
