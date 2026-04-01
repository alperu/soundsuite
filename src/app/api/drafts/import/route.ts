import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import JSZip from 'jszip';

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData();
    const file = formData.get('file') as File | null;

    if (!file) {
      return NextResponse.json({ error: 'No file provided' }, { status: 400 });
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const zip = await JSZip.loadAsync(buffer);

    // Build a map of caseNumber → caseId for linking
    const allCases = await prisma.case.findMany({
      select: { id: true, caseNumber: true, name: true },
    });
    const caseByNumber = new Map<string, string>();
    const caseByName = new Map<string, string>();
    for (const c of allCases) {
      if (c.caseNumber) caseByNumber.set(c.caseNumber, c.id);
      caseByName.set(c.name, c.id);
    }

    let imported = 0;
    let skipped = 0;
    const errors: string[] = [];

    // Process each JSON file in the zip
    const files = Object.keys(zip.files).filter(
      f => f.endsWith('.json') && f !== 'manifest.json'
    );

    for (const fileName of files) {
      try {
        const raw = await zip.files[fileName].async('text');
        const data = JSON.parse(raw);

        if (!data.title || !data.documentType) {
          errors.push(`${fileName}: missing title or documentType`);
          skipped++;
          continue;
        }

        // Resolve primary case
        let primaryCaseId: string | null = null;
        if (data.primaryCaseNumber && caseByNumber.has(data.primaryCaseNumber)) {
          primaryCaseId = caseByNumber.get(data.primaryCaseNumber)!;
        } else if (data.primaryCaseName && caseByName.has(data.primaryCaseName)) {
          primaryCaseId = caseByName.get(data.primaryCaseName)!;
        }

        if (!primaryCaseId) {
          // Use first available case as fallback
          if (allCases.length > 0) {
            primaryCaseId = allCases[0].id;
            errors.push(`${fileName}: case not found, assigned to "${allCases[0].name}"`);
          } else {
            errors.push(`${fileName}: no cases available, skipped`);
            skipped++;
            continue;
          }
        }

        // Resolve linked cases
        const additionalCaseIds: string[] = [];
        if (data.linkedCaseNumbers?.length) {
          for (const cn of data.linkedCaseNumbers) {
            const cid = caseByNumber.get(cn);
            if (cid && cid !== primaryCaseId) {
              additionalCaseIds.push(cid);
            }
          }
        }

        // Serialize content back to string for storage
        const content = typeof data.content === 'object'
          ? JSON.stringify(data.content)
          : data.content || '';

        // Generate unique slug
        let slug = data.slug || data.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 80);
        let suffix = 0;
        while (true) {
          const candidate = suffix === 0 ? slug : `${slug}-${suffix}`;
          const existing = await prisma.draft.findUnique({
            where: { caseId_slug: { caseId: primaryCaseId, slug: candidate } },
          });
          if (!existing) { slug = candidate; break; }
          suffix++;
        }

        // Create the draft
        const draft = await prisma.draft.create({
          data: {
            caseId: primaryCaseId,
            title: data.title,
            slug,
            documentType: data.documentType,
            content,
            status: data.status || 'draft',
            version: data.version || 1,
            draftCases: {
              create: [
                { caseId: primaryCaseId },
                ...additionalCaseIds.map(cid => ({ caseId: cid })),
              ],
            },
          },
        });

        // Import version history
        if (data.versions?.length) {
          for (const v of data.versions) {
            const vContent = typeof v.content === 'object'
              ? JSON.stringify(v.content)
              : v.content || '';

            await prisma.draftVersion.create({
              data: {
                draftId: draft.id,
                version: v.version,
                content: vContent,
                changeSummary: v.changeSummary || null,
              },
            });
          }
        }

        imported++;
      } catch (e: any) {
        errors.push(`${fileName}: ${e.message}`);
        skipped++;
      }
    }

    return NextResponse.json({ imported, skipped, errors });
  } catch (e: any) {
    return NextResponse.json({ error: e.message || 'Import failed' }, { status: 500 });
  }
}
