import { NextRequest } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import JSZip from 'jszip';

export async function GET(request: NextRequest) {
  const caseId = request.nextUrl.searchParams.get('caseId');

  // Fetch drafts with versions and linked cases
  const where = caseId
    ? { OR: [{ caseId }, { draftCases: { some: { caseId } } }] }
    : {};

  const drafts = await prisma.draft.findMany({
    where,
    include: {
      case: { select: { id: true, name: true, caseNumber: true } },
      draftCases: {
        include: {
          case: { select: { id: true, name: true, caseNumber: true } },
        },
      },
      versions: {
        orderBy: { version: 'asc' },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });

  const zip = new JSZip();

  // Add manifest
  zip.file('manifest.json', JSON.stringify({
    exportDate: new Date().toISOString(),
    appVersion: '0.1.0',
    draftCount: drafts.length,
  }, null, 2));

  // Add each draft as a JSON file
  for (let i = 0; i < drafts.length; i++) {
    const d = drafts[i];

    // Parse content if it's a JSON string
    let content: any = d.content;
    if (typeof content === 'string' && content.startsWith('{')) {
      try { content = JSON.parse(content); } catch {}
    }

    const linkedCaseNumbers = d.draftCases
      .map(dc => dc.case.caseNumber)
      .filter(Boolean) as string[];

    const draftData = {
      title: d.title,
      slug: d.slug,
      documentType: d.documentType,
      status: d.status,
      version: d.version,
      content,
      primaryCaseNumber: d.case?.caseNumber || null,
      primaryCaseName: d.case?.name || null,
      linkedCaseNumbers,
      createdAt: d.createdAt.toISOString(),
      updatedAt: d.updatedAt.toISOString(),
      versions: d.versions.map(v => {
        let vContent: any = v.content;
        if (typeof vContent === 'string' && vContent.startsWith('{')) {
          try { vContent = JSON.parse(vContent); } catch {}
        }
        return {
          version: v.version,
          content: vContent,
          changeSummary: v.changeSummary,
          createdAt: v.createdAt.toISOString(),
        };
      }),
    };

    const safeName = d.slug || d.title.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    zip.file(`draft-${i + 1}-${safeName}.json`, JSON.stringify(draftData, null, 2));
  }

  const buffer = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE' });
  const date = new Date().toISOString().slice(0, 10);

  return new Response(buffer as unknown as BodyInit, {
    headers: {
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="drafts-export-${date}.zip"`,
      'Content-Length': String(buffer.length),
    },
  });
}
