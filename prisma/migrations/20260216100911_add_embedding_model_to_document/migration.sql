-- AlterTable
ALTER TABLE "Document" ADD COLUMN "embeddingModel" TEXT;

-- CreateIndex
CREATE INDEX "Document_embeddingModel_idx" ON "Document"("embeddingModel");
