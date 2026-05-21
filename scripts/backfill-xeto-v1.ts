#!/usr/bin/env tsx
/**
 * XETO v1 foundation backfill script.
 *
 * Dry-run by default. Pass `--apply` to actually write rows.
 *
 *   npx tsx scripts/backfill-xeto-v1.ts           # dry-run
 *   npx tsx scripts/backfill-xeto-v1.ts --apply   # commit
 *
 * What it does:
 *  1. Ensures a `self` Person row exists (intrinsic tags { person, lawyer, self }).
 *  2. For each existing Filing whose `filingType` looks like a motion, propose a
 *     new Motion row + a MotionEvent { kind: "filed", occurredOn: filingDate }.
 *  3. Heuristically detects amendment chains from the filename via the same
 *     MODIFIER_WORDS regex used by `src/services/filing-detector.ts` and prints
 *     a human-review table (filename, modifier matched, proposed parent slug).
 *     Does NOT auto-link — that's the user's call.
 *
 * Per §10 step 5.5 of docs/xeto-haystack-research.md.
 */

import { PrismaClient } from "@prisma/client";

const APPLY = process.argv.includes("--apply");

// Mirror of src/services/filing-detector.ts MODIFIER_WORDS — keep in sync.
const MODIFIER_WORDS =
  /\b(?:supplemental|amended|emergency|original|corrected|revised|second|third|fourth|fifth|first)\b/i;

// "Motion"-like filingType detection. Matches `Motion`, `motion`, `motion-to-*`, etc.
const MOTION_RE = /\bmotion\b/i;

type Proposal = {
  kind: "create-motion" | "create-event" | "amendment-link" | "ensure-self";
  // Free-form summary for the dry-run table.
  detail: Record<string, unknown>;
};

async function main() {
  const prisma = new PrismaClient();
  const proposals: Proposal[] = [];

  try {
    // ── 1. Ensure self Person ─────────────────────────────────────────────
    const existingSelf = await prisma.person.findFirst({
      where: { tags: { path: ["self"], equals: true } },
    });
    if (!existingSelf) {
      proposals.push({
        kind: "ensure-self",
        detail: {
          displayName: "Me",
          tags: { person: true, lawyer: true, self: true },
        },
      });
      if (APPLY) {
        await prisma.person.create({
          data: {
            displayName: "Me",
            tags: { person: true, lawyer: true, self: true },
          },
        });
      }
    }

    // ── 2. Motion + MotionEvent proposals from Filing ─────────────────────
    const filings = await prisma.filing.findMany({
      select: {
        id: true,
        caseId: true,
        filingType: true,
        title: true,
        slug: true,
        filingDate: true,
        isSupplemental: true,
        supplementalOrder: true,
        documents: { select: { id: true, fileName: true } },
      },
    });

    const motionFilings = filings.filter((f) => MOTION_RE.test(f.filingType));
    const amendmentRows: {
      filing: string;
      file: string;
      modifier: string;
      proposedParent: string | null;
    }[] = [];

    // Slug → filings index so we can propose parents by matching base slug.
    const bySlug = new Map<string, typeof motionFilings>();
    for (const f of motionFilings) {
      const arr = bySlug.get(f.slug) ?? [];
      arr.push(f);
      bySlug.set(f.slug, arr);
    }

    for (const f of motionFilings) {
      // (a) Propose a Motion row (only if there isn't already a Motion linked
      //     to this filing via the existing Motion.filingId column).
      const existing = await prisma.motion.findFirst({
        where: { filingId: f.id },
      });
      const motionTitle = f.title ?? f.slug;
      if (!existing) {
        proposals.push({
          kind: "create-motion",
          detail: {
            filingId: f.id,
            caseId: f.caseId,
            title: motionTitle,
            revisionSeq: f.supplementalOrder ?? (f.isSupplemental ? 2 : 1),
            tags: {
              motion: true,
              equip: true,
              motionType: extractMotionType(f.title ?? f.slug),
            },
          },
        });
      }

      // (b) Propose a MotionEvent { filed }.
      if (f.filingDate) {
        proposals.push({
          kind: "create-event",
          detail: {
            filingId: f.id,
            kind: "filed",
            occurredOn: f.filingDate,
            documentId: f.documents[0]?.id ?? null,
            tags: { motionEvent: true, point: true, filed: true, kind: "filed" },
          },
        });
      }

      // (c) Heuristic amendment-chain detection from filenames.
      for (const doc of f.documents) {
        const m = doc.fileName.match(MODIFIER_WORDS);
        if (!m) continue;
        // Strip modifier word from filename + look for sibling filings whose
        // base title matches. Cheap heuristic — user reviews the table.
        const baseTitle = (f.title ?? f.slug)
          .replace(MODIFIER_WORDS, "")
          .replace(/\s+/g, " ")
          .trim()
          .toLowerCase();
        const candidate = motionFilings.find(
          (x) =>
            x.id !== f.id &&
            x.caseId === f.caseId &&
            (x.title ?? x.slug).toLowerCase().includes(baseTitle) &&
            !MODIFIER_WORDS.test(x.title ?? "") &&
            (!x.filingDate ||
              !f.filingDate ||
              x.filingDate < f.filingDate),
        );
        amendmentRows.push({
          filing: f.title ?? f.slug,
          file: doc.fileName,
          modifier: m[0],
          proposedParent: candidate ? candidate.slug : null,
        });
      }
    }

    // ── 3. Report ────────────────────────────────────────────────────────
    console.log(
      `\nXETO v1 backfill — ${APPLY ? "APPLY" : "DRY-RUN"} mode\n` +
        "═".repeat(60),
    );
    console.log(`Filings scanned:                ${filings.length}`);
    console.log(`Motion-like filings:            ${motionFilings.length}`);
    const motionsCreated = proposals.filter(
      (p) => p.kind === "create-motion",
    ).length;
    const eventsCreated = proposals.filter(
      (p) => p.kind === "create-event",
    ).length;
    console.log(`Motion rows to create:          ${motionsCreated}`);
    console.log(`MotionEvent rows to create:     ${eventsCreated}`);
    console.log(
      `Self Person row needed:         ${existingSelf ? "no (already exists)" : APPLY ? "created" : "yes (would create)"}`,
    );

    if (amendmentRows.length) {
      console.log(
        `\nAmendment-chain proposals (human review — NOT auto-linked):`,
      );
      console.table(amendmentRows);
    } else {
      console.log("\nNo amendment-chain candidates found in filenames.");
    }

    if (!APPLY) {
      console.log(
        "\n[dry-run] No rows written. Re-run with --apply to commit Motion/MotionEvent rows.",
      );
    } else {
      console.log(
        "\n[apply] Motion/MotionEvent writes are NOT yet implemented in this script — only the `self` Person row is committed. Implement after schema lands.",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

function extractMotionType(title: string): string {
  const t = title.toLowerCase();
  if (/\bdisqualif/.test(t)) return "disqualify";
  if (/\bvacat/.test(t)) return "vacate";
  if (/\bcompel/.test(t)) return "compel";
  if (/summary judgment/.test(t)) return "summaryJudgment";
  if (/\bdismiss/.test(t)) return "dismiss";
  if (/\bcontinuance/.test(t)) return "continuance";
  if (/protective order/.test(t)) return "protectiveOrder";
  return "other";
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
