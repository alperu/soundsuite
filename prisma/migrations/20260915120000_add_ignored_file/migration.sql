-- Remember files the operator rejected, so the watcher stops re-creating them.
--
-- Deleting a Document does not stop it coming back: the PDF is still on disk,
-- findCaseForFile re-attributes it on the next `add` event, and
-- POST /api/cases/[id]/rescan deliberately restarts the FileWatcher so chokidar
-- re-walks every path. onFileAdded dedupes against existing rows by hash and
-- filePath, but once the row is deleted there is nothing left to match, so the
-- file is recreated as DISCOVERED. This table is that missing memory.
--
-- Purely additive: no existing table is touched, so applying it cannot affect
-- Case, Document or any indexed data.

-- CreateTable
CREATE TABLE "IgnoredFile" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT,
    "filePath" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "reason" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "IgnoredFile_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
-- One tombstone per location. The watcher's own filePath uniqueness on
-- Document mirrors this.
CREATE UNIQUE INDEX "IgnoredFile_filePath_key" ON "IgnoredFile"("filePath");

-- Deliberately NOT unique: the same bytes can legitimately sit at two paths,
-- and each may be rejected independently. Indexed because the watcher looks up
-- by hash on every discovered file.
CREATE INDEX "IgnoredFile_hash_idx" ON "IgnoredFile"("hash");

CREATE INDEX "IgnoredFile_caseId_idx" ON "IgnoredFile"("caseId");
