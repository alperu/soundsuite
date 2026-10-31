-- CreateTable
CREATE TABLE "Filing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "filingType" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "filingDate" DATETIME,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Filing_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Document" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT NOT NULL,
    "filingId" TEXT,
    "filePath" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "documentType" TEXT,
    "documentSummary" TEXT,
    "exhibitLabel" TEXT,
    "errorMessage" TEXT,
    "pageCount" INTEGER,
    "detectedExhibits" INTEGER NOT NULL DEFAULT 0,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Document_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Document_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("caseId", "createdAt", "detectedExhibits", "documentSummary", "documentType", "errorMessage", "fileName", "filePath", "hash", "id", "pageCount", "status", "updatedAt") SELECT "caseId", "createdAt", "detectedExhibits", "documentSummary", "documentType", "errorMessage", "fileName", "filePath", "hash", "id", "pageCount", "status", "updatedAt" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE UNIQUE INDEX "Document_filePath_key" ON "Document"("filePath");
CREATE UNIQUE INDEX "Document_hash_key" ON "Document"("hash");
CREATE INDEX "Document_caseId_idx" ON "Document"("caseId");
CREATE INDEX "Document_filingId_idx" ON "Document"("filingId");
CREATE INDEX "Document_status_idx" ON "Document"("status");
CREATE INDEX "Document_hash_idx" ON "Document"("hash");
CREATE INDEX "Document_documentType_idx" ON "Document"("documentType");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE INDEX "Filing_caseId_idx" ON "Filing"("caseId");

-- CreateIndex
CREATE INDEX "Filing_filingType_idx" ON "Filing"("filingType");

-- CreateIndex
CREATE UNIQUE INDEX "Filing_caseId_slug_key" ON "Filing"("caseId", "slug");
