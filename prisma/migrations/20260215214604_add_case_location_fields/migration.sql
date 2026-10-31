-- AlterTable
ALTER TABLE "Case" ADD COLUMN "country" TEXT DEFAULT 'United States';
ALTER TABLE "Case" ADD COLUMN "county" TEXT;
ALTER TABLE "Case" ADD COLUMN "state" TEXT;
