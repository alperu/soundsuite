/**
 * Seed a handful of common Texas courts so the ref-picker has real data
 * from day one. Dry-run by default; pass `--apply` to actually write.
 *
 *   npx tsx scripts/seed-courts.ts          # dry-run
 *   npx tsx scripts/seed-courts.ts --apply  # commit
 */
import 'dotenv/config'
import { prisma } from '../src/lib/db/prisma'

interface Seed {
  name: string
  shortName?: string
  courtType: 'trial' | 'appellate' | 'supreme' | 'magistrate'
  jurisdictionCode?: string // matches Jurisdiction.code if it exists
  address?: string
  website?: string
}

const SEEDS: Seed[] = [
  {
    name: 'Travis County District Court',
    shortName: 'Travis Co. Dist. Ct.',
    courtType: 'trial',
    jurisdictionCode: 'TX',
    address: '1000 Guadalupe St, Austin, TX 78701',
  },
  {
    name: 'Texas 3rd Court of Appeals',
    shortName: '3d Tex. App.',
    courtType: 'appellate',
    jurisdictionCode: 'TX',
    address: '209 W. 14th St, Austin, TX 78701',
    website: 'https://www.txcourts.gov/3rdcoa',
  },
  {
    name: 'Supreme Court of Texas',
    shortName: 'Tex.',
    courtType: 'supreme',
    jurisdictionCode: 'TX',
    address: '201 W. 14th St, Austin, TX 78701',
    website: 'https://www.txcourts.gov/supreme',
  },
]

async function main() {
  const apply = process.argv.includes('--apply')
  console.log(`[seed-courts] mode=${apply ? 'APPLY' : 'DRY-RUN'}`)

  for (const seed of SEEDS) {
    let jurisdictionId: string | null = null
    if (seed.jurisdictionCode) {
      const j = await prisma.jurisdiction.findUnique({ where: { code: seed.jurisdictionCode } })
      jurisdictionId = j?.id ?? null
      if (!jurisdictionId) {
        console.log(`  · jurisdiction "${seed.jurisdictionCode}" not found — court will have no FK`)
      }
    }

    // Idempotent: skip if a court with the same name already exists.
    const existing = await prisma.court.findFirst({ where: { name: seed.name } })
    if (existing) {
      console.log(`  · skip "${seed.name}" (exists, id=${existing.id})`)
      continue
    }

    const tagBag: Record<string, unknown> = {
      court: true,
      courtType: seed.courtType,
    }
    if (jurisdictionId) tagBag.jurisdictionRef = `@${jurisdictionId}`

    if (!apply) {
      console.log(`  + would create "${seed.name}" (${seed.courtType}, jurisdiction=${jurisdictionId ?? '—'})`)
      continue
    }
    const created = await prisma.court.create({
      data: {
        name: seed.name,
        shortName: seed.shortName ?? null,
        jurisdictionId,
        courtType: seed.courtType,
        address: seed.address ?? null,
        website: seed.website ?? null,
        tags: tagBag,
      },
    })
    console.log(`  + created "${created.name}" (id=${created.id})`)
  }

  if (!apply) {
    console.log('\n[seed-courts] dry-run complete. Pass --apply to commit.')
  } else {
    console.log('\n[seed-courts] done.')
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(async () => {
    // The extended client has no $disconnect but the underlying does.
    try { await (prisma as any).$disconnect?.() } catch { /* noop */ }
  })
