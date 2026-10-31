-- CreateTable
CREATE TABLE "PageCache" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "documentId" TEXT NOT NULL,
    "pageNumber" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "textDensity" INTEGER NOT NULL,
    "source" TEXT NOT NULL,
    "confidence" REAL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- CreateIndex
CREATE INDEX "PageCache_documentId_idx" ON "PageCache"("documentId");

-- CreateIndex
CREATE INDEX "PageCache_source_idx" ON "PageCache"("source");

-- CreateIndex
CREATE UNIQUE INDEX "PageCache_documentId_pageNumber_key" ON "PageCache"("documentId", "pageNumber");
