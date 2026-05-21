#!/usr/bin/env tsx
/**
 * Seed US Jurisdictions and Courts.
 *
 *   npx tsx scripts/seed-jurisdictions-courts.ts            # dry-run (default)
 *   npx tsx scripts/seed-jurisdictions-courts.ts --apply    # commit to DB
 *
 * Sources are documented in `src/lib/jurisdictions/us-jurisdictions.ts` and
 * `src/lib/jurisdictions/us-courts.ts`.
 *
 * Safety:
 *   - Dry-run by default. `--apply` is required to write rows.
 *   - Idempotent: each entry is checked by `code` (jurisdiction) or by
 *     `(name, jurisdictionId)` (court) before creating.
 *   - Per CLAUDE.md, this script should NOT be auto-run by Claude — the
 *     user is expected to review the dry-run summary and invoke `--apply`
 *     manually.
 *
 * Construction pattern mirrors `scripts/backfill-xeto-v1.ts` (Prisma 7 +
 * better-sqlite3 adapter).
 */

import path from "node:path";
import { PrismaClient } from "@prisma/client";
import { PrismaBetterSqlite3 } from "@prisma/adapter-better-sqlite3";

import { US_JURISDICTIONS } from "../src/lib/jurisdictions/us-jurisdictions";
import { US_COURTS } from "../src/lib/jurisdictions/us-courts";

const APPLY = process.argv.includes("--apply");

function makePrisma(): PrismaClient {
  const url = process.env.DATABASE_URL ?? "file:./data/sound-suite.db";
  const stripped = url.startsWith("file:") ? url.slice("file:".length) : url;
  const dbPath = path.isAbsolute(stripped)
    ? stripped
    : path.resolve(process.cwd(), "prisma", stripped);
  const adapter = new PrismaBetterSqlite3({ url: dbPath });
  return new PrismaClient({ adapter });
}

type Counters = {
  jurisdictionsExisting: number;
  jurisdictionsCreated: number;
  jurisdictionsProposed: number;
  courtsExisting: number;
  courtsCreated: number;
  courtsProposed: number;
  courtsSkipped: number;
};

async function seedJurisdictions(
  prisma: PrismaClient,
  counters: Counters,
): Promise<Map<string, string>> {
  // Returns map of catalogue code -> Prisma Jurisdiction.id
  const codeToId = new Map<string, string>();

  for (const entry of US_JURISDICTIONS) {
    const existing = await prisma.jurisdiction.findFirst({
      where: { code: entry.code },
    });
    if (existing) {
      counters.jurisdictionsExisting++;
      codeToId.set(entry.code, existing.id);
      continue;
    }

    const tags: Record<string, unknown> = {
      jurisdiction: true,
      level: entry.level,
    };
    if (entry.fipsCode) tags.fipsCode = entry.fipsCode;
    if (entry.parentCode) tags.parentCode = entry.parentCode;

    if (APPLY) {
      const created = await prisma.jurisdiction.create({
        data: {
          code: entry.code,
          name: entry.displayName,
          tags: tags as object,
        },
      });
      codeToId.set(entry.code, created.id);
      counters.jurisdictionsCreated++;
    } else {
      counters.jurisdictionsProposed++;
    }
  }

  return codeToId;
}

async function seedCourts(
  prisma: PrismaClient,
  jurisdictionMap: Map<string, string>,
  counters: Counters,
): Promise<void> {
  for (const entry of US_COURTS) {
    const jurisdictionId = jurisdictionMap.get(entry.jurisdictionCode);
    if (!jurisdictionId) {
      // In dry-run, the parent jurisdiction wasn't created so we can't link.
      // Skip the row but count it as proposed.
      if (!APPLY) {
        counters.courtsProposed++;
        continue;
      }
      console.warn(
        `[skip] court ${entry.code} — parent jurisdiction ${entry.jurisdictionCode} not found in DB`,
      );
      counters.courtsSkipped++;
      continue;
    }

    const existing = await prisma.court.findFirst({
      where: { name: entry.name, jurisdictionId },
    });
    if (existing) {
      counters.courtsExisting++;
      continue;
    }

    const tags: Record<string, unknown> = {
      court: true,
      code: entry.code,
    };
    if (entry.district) tags.district = entry.district;

    if (APPLY) {
      await prisma.court.create({
        data: {
          name: entry.name,
          shortName: entry.shortName ?? null,
          jurisdictionId,
          courtType: entry.courtType,
          address: entry.address ?? null,
          website: entry.website ?? null,
          tags: tags as object,
        },
      });
      counters.courtsCreated++;
    } else {
      counters.courtsProposed++;
    }
  }
}

async function main() {
  const prisma = makePrisma();
  const counters: Counters = {
    jurisdictionsExisting: 0,
    jurisdictionsCreated: 0,
    jurisdictionsProposed: 0,
    courtsExisting: 0,
    courtsCreated: 0,
    courtsProposed: 0,
    courtsSkipped: 0,
  };

  try {
    console.log(`\n${APPLY ? "APPLY" : "DRY-RUN"} mode\n`);
    console.log(`Catalogue: ${US_JURISDICTIONS.length} jurisdictions, ${US_COURTS.length} courts`);

    const jurisdictionMap = await seedJurisdictions(prisma, counters);
    await seedCourts(prisma, jurisdictionMap, counters);

    console.log("\n── Summary ─────────────────────────────────────────");
    console.log(`Jurisdictions  existing: ${counters.jurisdictionsExisting}`);
    if (APPLY) {
      console.log(`Jurisdictions  created : ${counters.jurisdictionsCreated}`);
    } else {
      console.log(`Jurisdictions  proposed: ${counters.jurisdictionsProposed}`);
    }
    console.log(`Courts         existing: ${counters.courtsExisting}`);
    if (APPLY) {
      console.log(`Courts         created : ${counters.courtsCreated}`);
      if (counters.courtsSkipped > 0) {
        console.log(`Courts         skipped : ${counters.courtsSkipped} (missing parent jurisdiction)`);
      }
    } else {
      console.log(`Courts         proposed: ${counters.courtsProposed}`);
    }
    if (!APPLY) {
      console.log("\nNo changes written. Re-run with --apply to commit.");
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
