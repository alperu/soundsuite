-- CreateTable
CREATE TABLE "Jurisdiction" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);

-- CreateTable
CREATE TABLE "Person" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "displayName" TEXT NOT NULL,
    "email" TEXT,
    "barNumber" TEXT,
    "jurisdictionId" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Person_jurisdictionId_fkey" FOREIGN KEY ("jurisdictionId") REFERENCES "Jurisdiction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "PersonRole" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "personId" TEXT NOT NULL,
    "scopeKind" TEXT NOT NULL,
    "scopeId" TEXT NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "appearedOn" DATETIME,
    "withdrewOn" DATETIME,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "PersonRole_personId_fkey" FOREIGN KEY ("personId") REFERENCES "Person" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MotionEvent" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "motionId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "occurredOn" DATETIME NOT NULL,
    "courtFilingDate" DATETIME,
    "causeNoStamp" TEXT,
    "documentId" TEXT,
    "authoredById" TEXT,
    "servedOnId" TEXT,
    "courtClerkId" TEXT,
    "courtReporterId" TEXT,
    "hearingId" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MotionEvent_motionId_fkey" FOREIGN KEY ("motionId") REFERENCES "Motion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_authoredById_fkey" FOREIGN KEY ("authoredById") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_servedOnId_fkey" FOREIGN KEY ("servedOnId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_courtClerkId_fkey" FOREIGN KEY ("courtClerkId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_courtReporterId_fkey" FOREIGN KEY ("courtReporterId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionEvent_hearingId_fkey" FOREIGN KEY ("hearingId") REFERENCES "Hearing" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "MotionAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "motionId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "attachmentKind" TEXT NOT NULL,
    "documentId" TEXT,
    "amendsId" TEXT,
    "supersedesId" TEXT,
    "revisionSeq" INTEGER,
    "authoredById" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "MotionAttachment_motionId_fkey" FOREIGN KEY ("motionId") REFERENCES "Motion" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MotionAttachment_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "MotionAttachment_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionAttachment_amendsId_fkey" FOREIGN KEY ("amendsId") REFERENCES "MotionAttachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionAttachment_supersedesId_fkey" FOREIGN KEY ("supersedesId") REFERENCES "MotionAttachment" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "MotionAttachment_authoredById_fkey" FOREIGN KEY ("authoredById") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "Hearing" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "judgeId" TEXT,
    "courtReporterId" TEXT,
    "courtClerkId" TEXT,
    "scheduledFor" DATETIME NOT NULL,
    "heldOn" DATETIME,
    "durationMin" INTEGER,
    "location" TEXT,
    "transcriptDocumentId" TEXT,
    "hearingType" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Hearing_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Hearing_courtReporterId_fkey" FOREIGN KEY ("courtReporterId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Hearing_courtClerkId_fkey" FOREIGN KEY ("courtClerkId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Hearing_transcriptDocumentId_fkey" FOREIGN KEY ("transcriptDocumentId") REFERENCES "Document" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HearingCase" (
    "hearingId" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,

    PRIMARY KEY ("hearingId", "caseId"),
    CONSTRAINT "HearingCase_hearingId_fkey" FOREIGN KEY ("hearingId") REFERENCES "Hearing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HearingCase_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "HearingMotion" (
    "hearingId" TEXT NOT NULL,
    "motionId" TEXT NOT NULL,

    PRIMARY KEY ("hearingId", "motionId"),
    CONSTRAINT "HearingMotion_hearingId_fkey" FOREIGN KEY ("hearingId") REFERENCES "Hearing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "HearingMotion_motionId_fkey" FOREIGN KEY ("motionId") REFERENCES "Motion" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_Case" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "caseNumber" TEXT,
    "jurisdiction" TEXT,
    "country" TEXT DEFAULT 'United States',
    "state" TEXT,
    "county" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "jurisdictionId" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Case_jurisdictionId_fkey" FOREIGN KEY ("jurisdictionId") REFERENCES "Jurisdiction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Case" ("caseNumber", "country", "county", "createdAt", "id", "jurisdiction", "name", "path", "state", "updatedAt") SELECT "caseNumber", "country", "county", "createdAt", "id", "jurisdiction", "name", "path", "state", "updatedAt" FROM "Case";
DROP TABLE "Case";
ALTER TABLE "new_Case" RENAME TO "Case";
CREATE UNIQUE INDEX "Case_path_key" ON "Case"("path");
CREATE INDEX "Case_path_idx" ON "Case"("path");
CREATE INDEX "Case_caseNumber_idx" ON "Case"("caseNumber");
CREATE INDEX "Case_jurisdictionId_idx" ON "Case"("jurisdictionId");
CREATE TABLE "new_ChatAttachment" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "chatId" TEXT NOT NULL,
    "fileName" TEXT NOT NULL,
    "hash" TEXT NOT NULL,
    "sizeBytes" INTEGER NOT NULL,
    "mimeType" TEXT NOT NULL DEFAULT 'application/pdf',
    "kind" TEXT NOT NULL DEFAULT 'pdf',
    "pageCount" INTEGER,
    "chunkCount" INTEGER,
    "imageWidth" INTEGER,
    "imageHeight" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "error" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_ChatAttachment" ("chatId", "chunkCount", "createdAt", "error", "fileName", "hash", "id", "pageCount", "sizeBytes", "status", "updatedAt") SELECT "chatId", "chunkCount", "createdAt", "error", "fileName", "hash", "id", "pageCount", "sizeBytes", "status", "updatedAt" FROM "ChatAttachment";
DROP TABLE "ChatAttachment";
ALTER TABLE "new_ChatAttachment" RENAME TO "ChatAttachment";
CREATE INDEX "ChatAttachment_chatId_idx" ON "ChatAttachment"("chatId");
CREATE UNIQUE INDEX "ChatAttachment_chatId_hash_key" ON "ChatAttachment"("chatId", "hash");
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
    "embeddingModel" TEXT,
    "ingestCheckpoint" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Document_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Document_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Document" ("caseId", "createdAt", "detectedExhibits", "documentSummary", "documentType", "embeddingModel", "errorMessage", "exhibitLabel", "fileName", "filePath", "filingId", "hash", "id", "ingestCheckpoint", "pageCount", "status", "updatedAt") SELECT "caseId", "createdAt", "detectedExhibits", "documentSummary", "documentType", "embeddingModel", "errorMessage", "exhibitLabel", "fileName", "filePath", "filingId", "hash", "id", "ingestCheckpoint", "pageCount", "status", "updatedAt" FROM "Document";
DROP TABLE "Document";
ALTER TABLE "new_Document" RENAME TO "Document";
CREATE UNIQUE INDEX "Document_filePath_key" ON "Document"("filePath");
CREATE UNIQUE INDEX "Document_hash_key" ON "Document"("hash");
CREATE INDEX "Document_caseId_idx" ON "Document"("caseId");
CREATE INDEX "Document_filingId_idx" ON "Document"("filingId");
CREATE INDEX "Document_status_idx" ON "Document"("status");
CREATE INDEX "Document_hash_idx" ON "Document"("hash");
CREATE INDEX "Document_documentType_idx" ON "Document"("documentType");
CREATE INDEX "Document_embeddingModel_idx" ON "Document"("embeddingModel");
CREATE TABLE "new_Motion" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "filingId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "startPage" INTEGER NOT NULL,
    "endPage" INTEGER,
    "description" TEXT,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "caseId" TEXT,
    "parentMotionId" TEXT,
    "amendsId" TEXT,
    "supersedesId" TEXT,
    "revisionSeq" INTEGER,
    "judgeId" TEXT,
    "movantId" TEXT,
    "respondentId" TEXT,
    CONSTRAINT "Motion_filingId_fkey" FOREIGN KEY ("filingId") REFERENCES "Filing" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Motion_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "Motion_parentMotionId_fkey" FOREIGN KEY ("parentMotionId") REFERENCES "Motion" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Motion_judgeId_fkey" FOREIGN KEY ("judgeId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Motion_movantId_fkey" FOREIGN KEY ("movantId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "Motion_respondentId_fkey" FOREIGN KEY ("respondentId") REFERENCES "Person" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_Motion" ("createdAt", "description", "endPage", "filingId", "id", "startPage", "title", "updatedAt") SELECT "createdAt", "description", "endPage", "filingId", "id", "startPage", "title", "updatedAt" FROM "Motion";
DROP TABLE "Motion";
ALTER TABLE "new_Motion" RENAME TO "Motion";
CREATE INDEX "Motion_filingId_idx" ON "Motion"("filingId");
CREATE INDEX "Motion_caseId_idx" ON "Motion"("caseId");
CREATE INDEX "Motion_parentMotionId_idx" ON "Motion"("parentMotionId");
CREATE INDEX "Motion_amendsId_idx" ON "Motion"("amendsId");
CREATE INDEX "Motion_judgeId_idx" ON "Motion"("judgeId");
CREATE INDEX "Motion_movantId_idx" ON "Motion"("movantId");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;

-- CreateIndex
CREATE UNIQUE INDEX "Jurisdiction_code_key" ON "Jurisdiction"("code");

-- CreateIndex
CREATE INDEX "Person_displayName_idx" ON "Person"("displayName");

-- CreateIndex
CREATE INDEX "Person_jurisdictionId_idx" ON "Person"("jurisdictionId");

-- CreateIndex
CREATE INDEX "PersonRole_personId_idx" ON "PersonRole"("personId");

-- CreateIndex
CREATE INDEX "PersonRole_scopeKind_scopeId_idx" ON "PersonRole"("scopeKind", "scopeId");

-- CreateIndex
CREATE INDEX "MotionEvent_motionId_kind_idx" ON "MotionEvent"("motionId", "kind");

-- CreateIndex
CREATE INDEX "MotionEvent_occurredOn_idx" ON "MotionEvent"("occurredOn");

-- CreateIndex
CREATE INDEX "MotionEvent_kind_courtFilingDate_idx" ON "MotionEvent"("kind", "courtFilingDate");

-- CreateIndex
CREATE INDEX "MotionEvent_authoredById_idx" ON "MotionEvent"("authoredById");

-- CreateIndex
CREATE INDEX "MotionEvent_caseId_idx" ON "MotionEvent"("caseId");

-- CreateIndex
CREATE INDEX "MotionEvent_documentId_idx" ON "MotionEvent"("documentId");

-- CreateIndex
CREATE INDEX "MotionEvent_hearingId_idx" ON "MotionEvent"("hearingId");

-- CreateIndex
CREATE INDEX "MotionAttachment_motionId_attachmentKind_idx" ON "MotionAttachment"("motionId", "attachmentKind");

-- CreateIndex
CREATE INDEX "MotionAttachment_amendsId_idx" ON "MotionAttachment"("amendsId");

-- CreateIndex
CREATE INDEX "MotionAttachment_caseId_idx" ON "MotionAttachment"("caseId");

-- CreateIndex
CREATE INDEX "MotionAttachment_documentId_idx" ON "MotionAttachment"("documentId");

-- CreateIndex
CREATE INDEX "Hearing_scheduledFor_idx" ON "Hearing"("scheduledFor");

-- CreateIndex
CREATE INDEX "Hearing_judgeId_idx" ON "Hearing"("judgeId");

-- CreateIndex
CREATE INDEX "HearingCase_caseId_idx" ON "HearingCase"("caseId");

-- CreateIndex
CREATE INDEX "HearingMotion_motionId_idx" ON "HearingMotion"("motionId");

-- ─── XETO v1: VIRTUAL generated columns + indexes ───────────────────────
-- Hand-edited per §12.2 of docs/xeto-haystack-research.md. SQLite VIRTUAL
-- generated columns + ordinary indexes outperform raw expression indexes
-- on json_extract paths. Each column mirrors a hot tag inside `tags`.

-- Motion (equip) — parent pointer + amendment chain
ALTER TABLE "Motion" ADD COLUMN "motionRefV"  TEXT GENERATED ALWAYS AS (json_extract(tags, '$.motionRef'))  VIRTUAL;
ALTER TABLE "Motion" ADD COLUMN "amendsV"     TEXT GENERATED ALWAYS AS (json_extract(tags, '$.amends'))     VIRTUAL;
ALTER TABLE "Motion" ADD COLUMN "supersedesV" TEXT GENERATED ALWAYS AS (json_extract(tags, '$.supersedes')) VIRTUAL;
ALTER TABLE "Motion" ADD COLUMN "judgeRefV"   TEXT GENERATED ALWAYS AS (json_extract(tags, '$.judgeRef'))   VIRTUAL;
ALTER TABLE "Motion" ADD COLUMN "movantRefV"  TEXT GENERATED ALWAYS AS (json_extract(tags, '$.movantRef'))  VIRTUAL;
ALTER TABLE "Motion" ADD COLUMN "motionTypeV" TEXT GENERATED ALWAYS AS (json_extract(tags, '$.motionType')) VIRTUAL;
CREATE INDEX "idx_motion_parent" ON "Motion"("motionRefV");
CREATE INDEX "idx_motion_amends" ON "Motion"("amendsV");
CREATE INDEX "idx_motion_judge"  ON "Motion"("judgeRefV");
CREATE INDEX "idx_motion_movant" ON "Motion"("movantRefV");
CREATE INDEX "idx_motion_type"   ON "Motion"("motionTypeV");

-- MotionEvent (point) — kind + motion ref are the hot composite
ALTER TABLE "MotionEvent" ADD COLUMN "kindV"            TEXT GENERATED ALWAYS AS (json_extract(tags, '$.kind'))              VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "motionRefV"       TEXT GENERATED ALWAYS AS (json_extract(tags, '$.motionRef'))         VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "occurredOnV"      TEXT GENERATED ALWAYS AS (json_extract(tags, '$.occurredOn'))        VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "courtFilingDateV" TEXT GENERATED ALWAYS AS (json_extract(tags, '$.courtFilingDate'))   VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "authoredV"        TEXT GENERATED ALWAYS AS (json_extract(tags, '$.authoredBy'))        VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "clerkV"           TEXT GENERATED ALWAYS AS (json_extract(tags, '$.courtClerkRef'))     VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "reporterV"        TEXT GENERATED ALWAYS AS (json_extract(tags, '$.courtReporterRef'))  VIRTUAL;
ALTER TABLE "MotionEvent" ADD COLUMN "hearingRefV"      TEXT GENERATED ALWAYS AS (json_extract(tags, '$.hearingRef'))        VIRTUAL;
CREATE INDEX "idx_event_motion_kind" ON "MotionEvent"("motionRefV", "kindV");
CREATE INDEX "idx_event_due"         ON "MotionEvent"("occurredOnV");
CREATE INDEX "idx_event_court_filed" ON "MotionEvent"("kindV", "courtFilingDateV");
CREATE INDEX "idx_event_authored"    ON "MotionEvent"("authoredV");
CREATE INDEX "idx_event_clerk"       ON "MotionEvent"("clerkV");
CREATE INDEX "idx_event_reporter"    ON "MotionEvent"("reporterV");
CREATE INDEX "idx_event_hearing"     ON "MotionEvent"("hearingRefV");

-- MotionAttachment — kind + motion ref + own amendment chain
ALTER TABLE "MotionAttachment" ADD COLUMN "kindV"       TEXT GENERATED ALWAYS AS (json_extract(tags, '$.attachmentKind')) VIRTUAL;
ALTER TABLE "MotionAttachment" ADD COLUMN "motionRefV"  TEXT GENERATED ALWAYS AS (json_extract(tags, '$.motionRef'))      VIRTUAL;
ALTER TABLE "MotionAttachment" ADD COLUMN "amendsV"     TEXT GENERATED ALWAYS AS (json_extract(tags, '$.amends'))         VIRTUAL;
ALTER TABLE "MotionAttachment" ADD COLUMN "supersedesV" TEXT GENERATED ALWAYS AS (json_extract(tags, '$.supersedes'))     VIRTUAL;
CREATE INDEX "idx_att_motion_kind" ON "MotionAttachment"("motionRefV", "kindV");
CREATE INDEX "idx_att_amends"      ON "MotionAttachment"("amendsV");

-- Person — intrinsic markers
ALTER TABLE "Person" ADD COLUMN "lawyerV" BOOLEAN GENERATED ALWAYS AS (json_extract(tags, '$.lawyer')) VIRTUAL;
ALTER TABLE "Person" ADD COLUMN "judgeV"  BOOLEAN GENERATED ALWAYS AS (json_extract(tags, '$.judge'))  VIRTUAL;
CREATE INDEX "idx_person_lawyer" ON "Person"("lawyerV");
CREATE INDEX "idx_person_judge"  ON "Person"("judgeV");

-- PersonRole — pivot by personRef AND by scopeRef
ALTER TABLE "PersonRole" ADD COLUMN "personRefV" TEXT    GENERATED ALWAYS AS (json_extract(tags, '$.personRef')) VIRTUAL;
ALTER TABLE "PersonRole" ADD COLUMN "scopeRefV"  TEXT    GENERATED ALWAYS AS (json_extract(tags, '$.scopeRef'))  VIRTUAL;
ALTER TABLE "PersonRole" ADD COLUMN "movantV"    BOOLEAN GENERATED ALWAYS AS (json_extract(tags, '$.movant'))    VIRTUAL;
CREATE INDEX "idx_role_person" ON "PersonRole"("personRefV");
CREATE INDEX "idx_role_scope"  ON "PersonRole"("scopeRefV");
CREATE INDEX "idx_role_movant" ON "PersonRole"("scopeRefV", "movantV");

-- Hearing — scheduling + judge + hybrid marker
ALTER TABLE "Hearing" ADD COLUMN "scheduledForV" TEXT    GENERATED ALWAYS AS (json_extract(tags, '$.scheduledFor')) VIRTUAL;
ALTER TABLE "Hearing" ADD COLUMN "judgeRefV"     TEXT    GENERATED ALWAYS AS (json_extract(tags, '$.judgeRef'))     VIRTUAL;
ALTER TABLE "Hearing" ADD COLUMN "hybridV"       BOOLEAN GENERATED ALWAYS AS (json_extract(tags, '$.hybrid'))       VIRTUAL;
CREATE INDEX "idx_hearing_scheduled" ON "Hearing"("scheduledForV");
CREATE INDEX "idx_hearing_judge"     ON "Hearing"("judgeRefV");
