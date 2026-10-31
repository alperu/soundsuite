-- AlterTable
ALTER TABLE "Case" ADD COLUMN "caseNumber" TEXT;
ALTER TABLE "Case" ADD COLUMN "jurisdiction" TEXT;

-- AlterTable
ALTER TABLE "Document" ADD COLUMN "documentSummary" TEXT;
ALTER TABLE "Document" ADD COLUMN "documentType" TEXT;

-- CreateIndex
CREATE INDEX "Case_caseNumber_idx" ON "Case"("caseNumber");

-- CreateIndex
CREATE INDEX "Document_documentType_idx" ON "Document"("documentType");
