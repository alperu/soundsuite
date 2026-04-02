/**
 * TipTap JSON → PDF converter using pdfmake.
 * Mirrors the docx-exporter.ts structure.
 * Supports: headings, paragraphs, lists, tables, images, hyperlinks, page breaks.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface TipTapNode {
  type: string;
  attrs?: Record<string, any>;
  content?: TipTapNode[];
  marks?: Array<{ type: string; attrs?: Record<string, any> }>;
  text?: string;
}

interface ExportOptions {
  title?: string;
  pageSize?: 'letter' | 'a4' | 'legal';
  marginTop?: number;    // pixels (96 = 1 inch)
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  defaultFont?: string;
  defaultFontSize?: string;  // e.g. '12px'
  h1Size?: string;
  h2Size?: string;
  h3Size?: string;
  h4Size?: string;
  h5Size?: string;
  lineSpacing?: string;      // e.g. '1.5'
  paragraphSpacing?: string; // e.g. '12px'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function pxToPt(px: number): number {
  return Math.round(px / 1.333);
}

function parseFontSizePt(size: string | undefined): number | undefined {
  if (!size) return undefined;
  const num = parseFloat(size);
  if (isNaN(num)) return undefined;
  return pxToPt(num);
}

function pxToPoints(px: number): number {
  // 96px = 72pt (1 inch)
  return Math.round((px / 96) * 72);
}

// Slugify for internal anchor IDs
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 80);
}

// ---------------------------------------------------------------------------
// Inline content conversion
// ---------------------------------------------------------------------------

interface PdfTextSegment {
  text: string;
  bold?: boolean;
  italics?: boolean;
  decoration?: string;
  decorationStyle?: string;
  color?: string;
  fontSize?: number;
  font?: string;
  link?: string;
  linkToDestination?: string;
  background?: string;
  sub?: boolean;
  sup?: boolean;
}

function convertInlineContent(nodes: TipTapNode[]): PdfTextSegment[] {
  const segments: PdfTextSegment[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      const seg: PdfTextSegment = { text: node.text || '' };
      const marks = node.marks || [];

      for (const mark of marks) {
        switch (mark.type) {
          case 'bold':
            seg.bold = true;
            break;
          case 'italic':
            seg.italics = true;
            break;
          case 'underline':
            seg.decoration = (seg.decoration ? seg.decoration + ' ' : '') + 'underline';
            break;
          case 'strike':
            seg.decoration = (seg.decoration ? seg.decoration + ' ' : '') + 'lineThrough';
            break;
          case 'highlight':
            seg.background = '#facc15';
            break;
          case 'subscript':
            seg.sub = true;
            break;
          case 'superscript':
            seg.sup = true;
            break;
          case 'textStyle':
            if (mark.attrs?.fontFamily) seg.font = mark.attrs.fontFamily;
            if (mark.attrs?.fontSize) {
              const size = parseFontSizePt(mark.attrs.fontSize);
              if (size) seg.fontSize = size;
            }
            break;
          case 'link': {
            const href = mark.attrs?.href || '';
            if (href.startsWith('#')) {
              seg.linkToDestination = href.slice(1);
            } else {
              seg.link = href;
            }
            seg.color = '#2563eb';
            seg.decoration = (seg.decoration ? seg.decoration + ' ' : '') + 'underline';
            break;
          }
        }
      }

      segments.push(seg);
    } else if (node.type === 'hardBreak') {
      segments.push({ text: '\n' });
    }
  }

  return segments;
}

// ---------------------------------------------------------------------------
// Block node conversion
// ---------------------------------------------------------------------------

const ALIGNMENT_MAP: Record<string, string> = {
  left: 'left',
  center: 'center',
  right: 'right',
  justify: 'justify',
};

function convertBlockNode(node: TipTapNode, headingSizes: Record<number, number>, paraSpacing: number): any[] {
  const results: any[] = [];

  switch (node.type) {
    case 'paragraph': {
      const children = node.content ? convertInlineContent(node.content) : [{ text: '' }];
      const alignment = ALIGNMENT_MAP[node.attrs?.textAlign] || undefined;
      results.push({
        text: children.length > 0 ? children : [{ text: '' }],
        alignment,
        margin: [0, 0, 0, paraSpacing],
      });
      break;
    }

    case 'heading': {
      const level = node.attrs?.level || 1;
      const alignment = ALIGNMENT_MAP[node.attrs?.textAlign] || undefined;
      const fontSize = headingSizes[level] || 12;
      const headingSlug = slugify(
        (node.content || []).map(c => c.text || '').join('')
      );

      const children = node.content ? convertInlineContent(node.content) : [{ text: '' }];
      // Force bold and size on all segments
      const styledChildren = children.map(seg => ({
        ...seg,
        bold: true,
        fontSize,
        color: seg.color || '#000000',
      }));

      results.push({
        text: styledChildren,
        alignment,
        margin: [0, fontSize > 14 ? 8 : 4, 0, paraSpacing],
        id: headingSlug || undefined, // bookmark for internal links
      });
      break;
    }

    case 'bulletList': {
      const items = (node.content || []).map(li => {
        const paraNodes = (li.content || []).filter(c => c.type === 'paragraph');
        if (paraNodes.length === 0) return { text: '' };
        const segments = paraNodes.flatMap(p => p.content ? convertInlineContent(p.content) : [{ text: '' }]);
        return { text: segments };
      });
      results.push({ ul: items, margin: [0, 0, 0, paraSpacing] });
      break;
    }

    case 'orderedList': {
      const items = (node.content || []).map(li => {
        const paraNodes = (li.content || []).filter(c => c.type === 'paragraph');
        if (paraNodes.length === 0) return { text: '' };
        const segments = paraNodes.flatMap(p => p.content ? convertInlineContent(p.content) : [{ text: '' }]);
        return { text: segments };
      });
      results.push({ ol: items, margin: [0, 0, 0, paraSpacing] });
      break;
    }

    case 'table': {
      const rows = (node.content || []).map(row => {
        return (row.content || []).map(cell => {
          const cellContent = (cell.content || []).flatMap(
            child => convertBlockNode(child, headingSizes, paraSpacing)
          );
          return cellContent.length > 0 ? cellContent : [{ text: '' }];
        });
      });
      if (rows.length > 0) {
        results.push({
          table: {
            headerRows: 1,
            widths: Array(rows[0]?.length || 1).fill('*'),
            body: rows,
          },
          layout: 'lightHorizontalLines',
          margin: [0, 0, 0, paraSpacing],
        });
      }
      break;
    }

    case 'image': {
      const src = node.attrs?.src || '';
      const width = node.attrs?.width ? Math.min(Number(node.attrs.width), 500) : 400;
      if (src) {
        results.push({
          image: src,
          width,
          margin: [0, 4, 0, paraSpacing],
        });
      }
      break;
    }

    case 'horizontalRule': {
      results.push({ text: '', pageBreak: 'after' });
      break;
    }

    case 'tableOfContents': {
      results.push({
        toc: { title: { text: 'Table of Contents', bold: true, fontSize: 14, margin: [0, 0, 0, 8] } },
        margin: [0, 0, 0, paraSpacing],
      });
      break;
    }

    default: {
      // Recurse for unknown wrapper nodes
      if (node.content) {
        for (const child of node.content) {
          results.push(...convertBlockNode(child, headingSizes, paraSpacing));
        }
      }
      break;
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// Main export function
// ---------------------------------------------------------------------------

export async function exportToPdf(
  tiptapJson: Record<string, any>,
  options: ExportOptions = {}
): Promise<Blob> {
  // Dynamic import pdfmake (client-side only)
  const pdfMakeModule = await import('pdfmake/build/pdfmake');
  const pdfFontsModule = await import('pdfmake/build/vfs_fonts');
  const pdfMake = pdfMakeModule.default || pdfMakeModule;
  const pdfFonts = pdfFontsModule.default || pdfFontsModule;
  (pdfMake as any).vfs = (pdfFonts as any).pdfMake?.vfs || pdfFonts;

  const content = (tiptapJson.content || []) as TipTapNode[];

  // Heading sizes from options (px → pt)
  const headingSizes: Record<number, number> = {
    1: parseFontSizePt(options.h1Size) || 24,
    2: parseFontSizePt(options.h2Size) || 20,
    3: parseFontSizePt(options.h3Size) || 16,
    4: parseFontSizePt(options.h4Size) || 14,
    5: parseFontSizePt(options.h5Size) || 12,
  };

  const defaultFontSize = parseFontSizePt(options.defaultFontSize) || 12;
  const lineSpacing = parseFloat(options.lineSpacing || '1.5') || 1.5;
  const paraSpacingPt = options.paragraphSpacing ? pxToPt(parseFloat(options.paragraphSpacing)) : 6;

  // Convert all blocks
  const pdfContent = content.flatMap(node => convertBlockNode(node, headingSizes, paraSpacingPt));

  // Page sizes in points
  const PAGE_SIZES: Record<string, string> = {
    letter: 'LETTER',
    a4: 'A4',
    legal: 'LEGAL',
  };

  const docDefinition: any = {
    pageSize: PAGE_SIZES[options.pageSize || 'letter'] || 'LETTER',
    pageMargins: [
      pxToPoints(options.marginLeft || 96),
      pxToPoints(options.marginTop || 96),
      pxToPoints(options.marginRight || 96),
      pxToPoints(options.marginBottom || 96),
    ],
    defaultStyle: {
      fontSize: defaultFontSize,
      lineHeight: lineSpacing,
    },
    content: pdfContent,
    info: {
      title: options.title || 'Document',
    },
  };

  return new Promise((resolve, reject) => {
    try {
      const pdfDocGenerator = (pdfMake as any).createPdf(docDefinition);
      pdfDocGenerator.getBlob((blob: Blob) => {
        resolve(blob);
      });
    } catch (err) {
      reject(err);
    }
  });
}
