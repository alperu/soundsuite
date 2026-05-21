-- Task #9: Court entity. Adds the Court table + Case.courtId FK + hot-tag
-- VIRTUAL columns + ordinary indexes (per §12.2 of docs/xeto-haystack-research.md).
--
-- Hand-edited migration — Prisma's auto-generated CREATE TABLE for Court is
-- straightforward; the Case.courtId FK is added via a column-level ALTER. The
-- VIRTUAL columns block at the bottom mirrors hot tag paths used by the
-- ref-picker (`courtType`, `jurisdictionRef`).

-- ─── Court table ────────────────────────────────────────────────────────
CREATE TABLE "Court" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "shortName" TEXT,
    "jurisdictionId" TEXT,
    "courtType" TEXT,
    "address" TEXT,
    "phone" TEXT,
    "website" TEXT,
    "tags" JSONB NOT NULL DEFAULT '{}',
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL,
    CONSTRAINT "Court_jurisdictionId_fkey" FOREIGN KEY ("jurisdictionId") REFERENCES "Jurisdiction" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE INDEX "Court_jurisdictionId_idx" ON "Court"("jurisdictionId");
CREATE INDEX "Court_name_idx" ON "Court"("name");
CREATE INDEX "Court_courtType_idx" ON "Court"("courtType");

-- ─── Case.courtId ───────────────────────────────────────────────────────
-- SQLite supports ADD COLUMN with a foreign-key clause inline.
ALTER TABLE "Case" ADD COLUMN "courtId" TEXT REFERENCES "Court" ("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "Case_courtId_idx" ON "Case"("courtId");

-- ─── VIRTUAL columns + indexes for hot tag paths ────────────────────────
-- Hot tag paths surfaced from the Court.tags JSON. Matches the §12.2
-- pattern used by Person/Motion: `json_extract(...)` GENERATED ALWAYS AS
-- ... VIRTUAL + ordinary index on the virtual column.
ALTER TABLE "Court" ADD COLUMN "courtTypeV"       TEXT GENERATED ALWAYS AS (json_extract(tags, '$.courtType'))       VIRTUAL;
ALTER TABLE "Court" ADD COLUMN "jurisdictionRefV" TEXT GENERATED ALWAYS AS (json_extract(tags, '$.jurisdictionRef')) VIRTUAL;
CREATE INDEX "idx_court_type"             ON "Court"("courtTypeV");
CREATE INDEX "idx_court_jurisdiction_ref" ON "Court"("jurisdictionRefV");
