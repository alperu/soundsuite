-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_WorkflowTemplate" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "name" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "category" TEXT,
    "tags" TEXT NOT NULL DEFAULT '[]',
    "description" TEXT,
    "content" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" DATETIME NOT NULL
);
INSERT INTO "new_WorkflowTemplate" ("content", "createdAt", "description", "id", "jurisdiction", "name", "updatedAt") SELECT "content", "createdAt", "description", "id", "jurisdiction", "name", "updatedAt" FROM "WorkflowTemplate";
DROP TABLE "WorkflowTemplate";
ALTER TABLE "new_WorkflowTemplate" RENAME TO "WorkflowTemplate";
CREATE UNIQUE INDEX "WorkflowTemplate_name_key" ON "WorkflowTemplate"("name");
CREATE INDEX "WorkflowTemplate_category_idx" ON "WorkflowTemplate"("category");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
