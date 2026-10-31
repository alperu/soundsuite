-- CreateTable
CREATE TABLE "DraftSuggestion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "draftId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "draftVersion" INTEGER NOT NULL,
    "anchorFrom" INTEGER NOT NULL,
    "anchorTo" INTEGER NOT NULL,
    "originalText" TEXT NOT NULL,
    "proposedText" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "confidence" REAL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "denyReasonTags" TEXT NOT NULL DEFAULT '[]',
    "denyReasonText" TEXT,
    "regenerationCount" INTEGER NOT NULL DEFAULT 0,
    "resolvedAt" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "DraftSuggestion_draftId_fkey" FOREIGN KEY ("draftId") REFERENCES "Draft" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateIndex
CREATE INDEX "DraftSuggestion_draftId_status_idx" ON "DraftSuggestion"("draftId", "status");

-- CreateIndex
CREATE INDEX "DraftSuggestion_sessionId_idx" ON "DraftSuggestion"("sessionId");

-- CreateTable
CREATE TABLE "UserPreferenceSignal" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "caseId" TEXT,
    "draftId" TEXT,
    "documentType" TEXT,
    "signal" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "examplePairs" TEXT NOT NULL DEFAULT '[]',
    "weight" REAL NOT NULL DEFAULT 1.0,
    "lastSeenAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateIndex
CREATE INDEX "UserPreferenceSignal_draftId_signal_category_idx" ON "UserPreferenceSignal"("draftId", "signal", "category");

-- CreateIndex
CREATE INDEX "UserPreferenceSignal_caseId_idx" ON "UserPreferenceSignal"("caseId");
