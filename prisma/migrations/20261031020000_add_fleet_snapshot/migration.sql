-- Last good copy of sidecarmaster's fleet view (fleet.source = follow, task 57 / 3.6).
-- Purely additive: one new table, no change to existing rows.
CREATE TABLE "FleetSnapshot" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "masterUrl" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "hostCount" INTEGER NOT NULL DEFAULT 0,
    "generatedAt" DATETIME,
    "fetchedAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);
