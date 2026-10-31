-- Sidecar sync login per admin user (fileSystemSideCar receiver admin API).
-- Purely additive: new columns with defaults; existing rows keep dashboard login.
ALTER TABLE "AdminUser" ADD COLUMN "dashboardLogin" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "AdminUser" ADD COLUMN "syncEnabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "AdminUser" ADD COLUMN "syncRoots" TEXT NOT NULL DEFAULT '[]';
ALTER TABLE "AdminUser" ADD COLUMN "syncLastLoginAt" DATETIME;
