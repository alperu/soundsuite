-- ChatAttachment was created with `db push` (commit b101cdb5) and never got a
-- migration, so a fresh DB failed at 20260521052715_xeto_v1_foundation, which
-- copies from it. IF NOT EXISTS keeps this a no-op on DBs that already have it.
CREATE TABLE IF NOT EXISTS "ChatAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "pageCount" INTEGER,
    "chunkCount" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
CREATE INDEX IF NOT EXISTS "ChatAttachment_chatId_idx" ON "ChatAttachment"("chatId");
CREATE UNIQUE INDEX IF NOT EXISTS "ChatAttachment_chatId_hash_key" ON "ChatAttachment"("chatId", "hash");
