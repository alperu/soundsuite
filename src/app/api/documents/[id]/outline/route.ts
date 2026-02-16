import { NextRequest, NextResponse } from 'next/server';
import { prisma } from '@/lib/db/prisma';
import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';

const standardFontDataUrl = path.join(process.cwd(), 'node_modules/pdfjs-dist/standard_fonts/');

/**
 * GET /api/documents/[id]/outline
 *
 * Extracts TOC outline and headings from a PDF server-side.
 * Eliminates the need for the client to do heavy text analysis.
 *
 * Response: { outline: OutlineItem[], headings: ExtractedHeading[] }
 */

interface OutlineItem {
  title: string;
  dest: any;
  items: OutlineItem[];
}

interface ExtractedHeading {
  text: string;
  page: number;
}

// pdfjs-dist init (same pattern as pdf-parser.ts)
let _pdfjsLib: any = null;

function ensureDOMMatrix() {
  if (typeof globalThis.DOMMatrix === 'undefined') {
    (globalThis as any).DOMMatrix = class DOMMatrix {
      a = 1; b = 0; c = 0; d = 1; e = 0; f = 0;
      constructor(init?: any) {
        if (Array.isArray(init) && init.length >= 6)
          [this.a, this.b, this.c, this.d, this.e, this.f] = init;
      }
      multiplySelf() { return this; }
      inverse() { return new DOMMatrix(); }
      static fromMatrix() { return new DOMMatrix(); }
      static fromFloat32Array(a: Float32Array) { return new DOMMatrix(Array.from(a)); }
      static fromFloat64Array(a: Float64Array) { return new DOMMatrix(Array.from(a)); }
    };
  }
}

async function getPdfjsLib() {
  if (_pdfjsLib) return _pdfjsLib;
  ensureDOMMatrix();
  _pdfjsLib = await import('pdfjs-dist');
  _pdfjsLib.GlobalWorkerOptions.workerPort = null;
  return _pdfjsLib;
}

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params;

    const doc = await prisma.document.findUnique({
      where: { id },
      select: { filePath: true },
    });

    if (!doc) {
      return NextResponse.json({ error: 'Document not found' }, { status: 404 });
    }

    if (!fs.existsSync(doc.filePath)) {
      return NextResponse.json({ error: 'PDF file not found on disk' }, { status: 404 });
    }

    const pdfjsLib = await getPdfjsLib();
    const fileBuffer = await fsPromises.readFile(doc.filePath);
    const pdfDoc = await pdfjsLib.getDocument({
      data: new Uint8Array(fileBuffer),
      standardFontDataUrl,
    }).promise;

    // Try to get the built-in outline first
    let outline: OutlineItem[] = [];
    try {
      const rawOutline = await pdfDoc.getOutline();
      if (rawOutline?.length) {
        outline = rawOutline as OutlineItem[];
        await pdfDoc.destroy();
        return NextResponse.json({ outline, headings: [] }, {
          headers: { 'Cache-Control': 'private, max-age=3600' },
        });
      }
    } catch {}

    // Fallback: extract headings from text content
    const headings: ExtractedHeading[] = [];
    const maxPages = Math.min(pdfDoc.numPages, 100);

    for (let i = 1; i <= maxPages; i++) {
      try {
        const page = await pdfDoc.getPage(i);
        const content = await page.getTextContent();
        const items = content.items as any[];
        if (!items.length) { page.cleanup(); continue; }

        const fontSizes: Record<number, number> = {};
        for (const it of items) {
          if (it.str?.trim()) {
            const h = Math.round(it.height || it.transform?.[0] || 12);
            fontSizes[h] = (fontSizes[h] || 0) + it.str.length;
          }
        }
        const bodySizeNum = Number(
          Object.entries(fontSizes).sort((a, b) => b[1] - a[1])[0]?.[0] || 12
        );

        const lines: { text: string; fontSize: number }[] = [];
        let curLine = '', curSize = 0, curY = -1;
        for (const it of items) {
          if (!it.str) continue;
          const y = Math.round(it.transform?.[5] || 0);
          const h = Math.round(it.height || it.transform?.[0] || 12);
          if (curY === -1 || Math.abs(y - curY) < 3) {
            curLine += it.str;
            curSize = Math.max(curSize, h);
            curY = y;
          } else {
            if (curLine.trim()) lines.push({ text: curLine.trim(), fontSize: curSize });
            curLine = it.str; curSize = h; curY = y;
          }
        }
        if (curLine.trim()) lines.push({ text: curLine.trim(), fontSize: curSize });

        for (const ln of lines) {
          const t = ln.text.trim();
          if (t.length < 3 || t.length > 120) continue;
          if (/^(?:page\s+\d+|\d+$|\d{1,2}\/\d{1,2}\/\d{2,4})$/i.test(t)) continue;
          if (
            ln.fontSize > bodySizeNum + 1 ||
            (t === t.toUpperCase() && /[A-Z]{3,}/.test(t) && t.length > 4 && t.length < 80) ||
            /^(?:\d+\.|\([a-z]\)|\([0-9]+\)|[IVXLC]+\.|[A-Z]\.)\s+\S/.test(t)
          ) {
            if (headings.length && headings[headings.length - 1].text === t && headings[headings.length - 1].page === i) continue;
            headings.push({ text: t, page: i });
          }
        }

        page.cleanup();
      } catch {}
    }

    await pdfDoc.destroy();

    return NextResponse.json({ outline, headings }, {
      headers: { 'Cache-Control': 'private, max-age=3600' },
    });
  } catch (error) {
    return NextResponse.json(
      { error: error instanceof Error ? error.message : 'Failed to extract outline' },
      { status: 500 }
    );
  }
}
