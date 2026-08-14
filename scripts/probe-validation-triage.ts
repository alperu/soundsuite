/**
 * Triage for task #39: with Hayson conversion working, which stored rows miss
 * their spec, and why?
 *
 * Two failure classes with different fixes, so they are counted separately:
 *   unknown-key    → the app writes a tag the XETO spec never declared
 *                    (fix: declare the slot, or add it to INFRA_KEYS)
 *   missing-required → the spec demands a slot the row doesn't carry
 *                    (fix: data, or relax the spec)
 *
 * NOT a committed test. Counts and tag KEY names only — never tag values.
 *
 * Run: npx tsx scripts/probe-validation-triage.ts
 */
import { prisma } from '../src/lib/db/prisma';
import { validateTags, validateSubtypeTags } from '../src/lib/legal/xeto-namespace';

type Bucket = { rows: number; miss: number; subtypeMiss: number; baseOkSubtypeMiss: number };

function asObject(tags: unknown): Record<string, unknown> {
  if (!tags) return {};
  if (typeof tags === 'string') {
    try { return JSON.parse(tags) as Record<string, unknown>; } catch { return {}; }
  }
  return tags as Record<string, unknown>;
}

/** Pull the offending tag keys out of the enrichment lines. Keys, not values. */
function parseErrors(errors: string[]): { unknown: string[]; required: string[] } {
  const out = { unknown: [] as string[], required: [] as string[] };
  for (const e of errors) {
    const u = e.match(/^unknown for [^:]+: (.+)$/);
    if (u) out.unknown.push(...u[1].split(',').map(s => s.trim()));
    const r = e.match(/^missing required: (.+)$/);
    if (r) out.required.push(...r[1].split(',').map(s => s.trim()));
  }
  return out;
}

async function main(): Promise<void> {
  const buckets = new Map<string, Bucket>();
  const unknownKeys = new Map<string, number>();
  const requiredKeys = new Map<string, number>();
  const bump = (m: Map<string, number>, k: string) => m.set(k, (m.get(k) ?? 0) + 1);
  const bucket = (name: string): Bucket => {
    const b = buckets.get(name) ?? { rows: 0, miss: 0, subtypeMiss: 0, baseOkSubtypeMiss: 0 };
    buckets.set(name, b);
    return b;
  };

  const record = (name: string, errors: string[]) => {
    const { unknown, required } = parseErrors(errors);
    for (const k of unknown) bump(unknownKeys, `${name}:${k}`);
    for (const k of required) bump(requiredKeys, `${name}:${k}`);
  };

  const models: Array<[string, string, () => Promise<Array<{ tags: unknown; attachmentKind?: string | null }>>]> = [
    ['Case', 'Case', () => prisma.case.findMany({ select: { tags: true } })],
    ['Motion', 'Motion', () => prisma.motion.findMany({ select: { tags: true } })],
    ['MotionEvent', 'MotionEvent', () => prisma.motionEvent.findMany({ select: { tags: true } })],
    ['Person', 'Person', () => prisma.person.findMany({ select: { tags: true } })],
    ['Hearing', 'Hearing', () => prisma.hearing.findMany({ select: { tags: true } })],
  ];

  for (const [label, model, load] of models) {
    for (const row of await load()) {
      const b = bucket(label);
      b.rows += 1;
      const res = await validateTags(model, asObject(row.tags));
      if (!res.ok) { b.miss += 1; record(label, res.errors); }
    }
  }

  for (const row of await prisma.motionAttachment.findMany({
    select: { attachmentKind: true, tags: true },
  })) {
    const kind = row.attachmentKind ?? '(null)';
    const b = bucket(`att:${kind}`);
    b.rows += 1;
    const tags = asObject(row.tags);
    const base = await validateTags('MotionAttachment', tags, row.attachmentKind);
    if (!base.ok) { b.miss += 1; record(`att:${kind}`, base.errors); }
    const sub = await validateSubtypeTags('MotionAttachment', tags, row.attachmentKind);
    if (sub && !sub.ok) {
      b.subtypeMiss += 1;
      if (base.ok) b.baseOkSubtypeMiss += 1;
      record(`sub:${kind}`, sub.errors);
    }
  }

  console.log('bucket'.padEnd(22), 'rows'.padStart(5), 'baseMiss'.padStart(9), 'subMiss'.padStart(8), 'baseOk+subMiss'.padStart(15));
  for (const [name, b] of [...buckets].sort()) {
    console.log(
      name.padEnd(22), String(b.rows).padStart(5), String(b.miss).padStart(9),
      String(b.subtypeMiss).padStart(8), String(b.baseOkSubtypeMiss).padStart(15),
    );
  }
  console.log('\nUNKNOWN keys (app writes a tag the spec never declared) — bucket:key = rows');
  for (const [k, n] of [...unknownKeys].sort((a, b) => b[1] - a[1])) console.log(' ', k.padEnd(40), n);
  console.log('\nMISSING-REQUIRED slots — bucket:key = rows');
  for (const [k, n] of [...requiredKeys].sort((a, b) => b[1] - a[1])) console.log(' ', k.padEnd(40), n);
}

main().catch(e => { console.error(e); process.exit(1); });
