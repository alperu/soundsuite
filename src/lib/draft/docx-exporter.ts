/**
 * TipTap JSON → DOCX converter using the 'docx' package.
 * Converts TipTap editor JSON output to a Word document.
 */

import {
  Document,
  Paragraph,
  TextRun,
  HeadingLevel,
  AlignmentType,
  Table,
  TableRow,
  TableCell,
  WidthType,
  Packer,
  ImageRun,
  ExternalHyperlink,
  LevelFormat,
  convertInchesToTwip,
  HorizontalPositionAlign,
  VerticalPositionAlign,
  HorizontalPositionRelativeFrom,
  VerticalPositionRelativeFrom,
  FootnoteReferenceRun,
} from 'docx';

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
  marginTop?: number;   // pixels (96 = 1 inch)
  marginBottom?: number;
  marginLeft?: number;
  marginRight?: number;
  // Font/style settings from editor config
  defaultFont?: string;        // e.g. 'Times New Roman'
  defaultFontSize?: string;    // e.g. '12px'
  h1Size?: string;
  h2Size?: string;
  h3Size?: string;
  h4Size?: string;
  h5Size?: string;
  lineSpacing?: string;        // e.g. '1.5' (multiplier)
  paragraphSpacing?: string;   // e.g. '12px'
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HEADING_MAP: Record<number, (typeof HeadingLevel)[keyof typeof HeadingLevel]> = {
  1: HeadingLevel.HEADING_1,
  2: HeadingLevel.HEADING_2,
  3: HeadingLevel.HEADING_3,
  4: HeadingLevel.HEADING_4,
  5: HeadingLevel.HEADING_5,
};

const ALIGNMENT_MAP: Record<string, (typeof AlignmentType)[keyof typeof AlignmentType]> = {
  left: AlignmentType.LEFT,
  center: AlignmentType.CENTER,
  right: AlignmentType.RIGHT,
  justify: AlignmentType.JUSTIFIED,
};

function pxToTwip(px: number): number {
  // 1 inch = 96px = 1440 twips
  return Math.round((px / 96) * 1440);
}

function pxToHalfPt(px: number): number {
  // 1pt = 1.333px, half-points = pt * 2
  return Math.round((px / 1.333) * 2);
}

function parseFontSize(size: string | undefined): number | undefined {
  if (!size) return undefined;
  const num = parseFloat(size);
  if (isNaN(num)) return undefined;
  if (size.includes('pt')) {
    // pt → half-points directly (1pt = 2 half-points)
    return Math.round(num * 2);
  }
  // assume px, convert to half-points
  return pxToHalfPt(num);
}

// Parse image dimensions from binary data (PNG and JPEG headers)
function getImageDimensions(buffer: Buffer, format: string): { width: number; height: number } {
  try {
    if (format === 'png' && buffer.length > 24) {
      // PNG: width at offset 16 (4 bytes BE), height at offset 20 (4 bytes BE)
      const width = buffer.readUInt32BE(16);
      const height = buffer.readUInt32BE(20);
      if (width > 0 && height > 0) return { width, height };
    }
    if ((format === 'jpeg' || format === 'jpg') && buffer.length > 4) {
      // JPEG: scan for SOF0 marker (0xFF 0xC0) or SOF2 (0xFF 0xC2)
      let i = 2;
      while (i < buffer.length - 8) {
        if (buffer[i] === 0xFF) {
          const marker = buffer[i + 1];
          if (marker === 0xC0 || marker === 0xC2) {
            const height = buffer.readUInt16BE(i + 5);
            const width = buffer.readUInt16BE(i + 7);
            if (width > 0 && height > 0) return { width, height };
          }
          if (marker === 0xD9) break; // EOI
          const segLen = buffer.readUInt16BE(i + 2);
          i += 2 + segLen;
        } else {
          i++;
        }
      }
    }
  } catch {}
  return { width: 400, height: 300 }; // fallback
}

// Convert base64 data URL to buffer with real dimensions
function base64ToBuffer(dataUrl: string): { buffer: Buffer; width: number; height: number; format: string } | null {
  try {
    const match = dataUrl.match(/^data:image\/(png|jpe?g|gif|webp);base64,(.+)$/);
    if (!match) return null;
    const format = match[1];
    const buffer = Buffer.from(match[2], 'base64');
    const dims = getImageDimensions(buffer, format);
    return { buffer, ...dims, format };
  } catch {
    return null;
  }
}

// Module-scope footnote map (set during export, used by convertInlineContent)
let _footnoteMap: Map<string, number> = new Map();

// Build an ImageRun with correct scaling from TipTap node attrs
function createImageRun(node: TipTapNode): ImageRun | null {
  const imgData = base64ToBuffer(node.attrs?.src || '');
  if (!imgData) return null;

  const nodeWidth = node.attrs?.width ? Number(node.attrs.width) : null;
  let exportW = imgData.width;
  let exportH = imgData.height;

  // If the editor has a display width, scale proportionally
  if (nodeWidth && nodeWidth > 0 && imgData.width > 0) {
    const ratio = imgData.height / imgData.width;
    exportW = nodeWidth;
    exportH = Math.round(nodeWidth * ratio);
  }

  // Cap max width to ~6 inches (576px) for Word
  if (exportW > 576) {
    const ratio = exportH / exportW;
    exportW = 576;
    exportH = Math.round(576 * ratio);
  }

  const imgType = imgData.format === 'jpg' || imgData.format === 'jpeg' ? 'jpg' : 'png';
  const wrapping = node.attrs?.wrapping || 'inline';

  const baseOpts: any = {
    data: imgData.buffer,
    transformation: { width: exportW, height: exportH },
    type: imgType,
  };

  // Add floating for wrapped images
  if (wrapping === 'float-left' || wrapping === 'float-right') {
    baseOpts.floating = {
      horizontalPosition: {
        relative: HorizontalPositionRelativeFrom.MARGIN,
        align: wrapping === 'float-left'
          ? HorizontalPositionAlign.LEFT
          : HorizontalPositionAlign.RIGHT,
      },
      verticalPosition: {
        relative: VerticalPositionRelativeFrom.PARAGRAPH,
        align: VerticalPositionAlign.TOP,
      },
      wrap: {
        type: 1, // square wrapping
        side: 3, // both sides
      },
    };
  } else if (wrapping === 'block') {
    // Center: use floating with center alignment
    baseOpts.floating = {
      horizontalPosition: {
        relative: HorizontalPositionRelativeFrom.MARGIN,
        align: HorizontalPositionAlign.CENTER,
      },
      verticalPosition: {
        relative: VerticalPositionRelativeFrom.PARAGRAPH,
        align: VerticalPositionAlign.TOP,
      },
      wrap: {
        type: 3, // top and bottom wrapping (no text beside image)
        side: 3,
      },
    };
  }

  return new ImageRun(baseOpts);
}

// ---------------------------------------------------------------------------
// Text run conversion
// ---------------------------------------------------------------------------

function convertTextNode(node: TipTapNode): TextRun {
  const text = node.text || '';
  const marks = node.marks || [];

  const options: Record<string, any> = { text };

  for (const mark of marks) {
    switch (mark.type) {
      case 'bold':
        options.bold = true;
        break;
      case 'italic':
        options.italics = true;
        break;
      case 'underline':
        options.underline = {};
        break;
      case 'strike':
        options.strike = true;
        break;
      case 'highlight':
        options.highlight = 'yellow';
        break;
      case 'subscript':
        options.subScript = true;
        break;
      case 'superscript':
        options.superScript = true;
        break;
      case 'textStyle':
        if (mark.attrs?.fontFamily) {
          options.font = mark.attrs.fontFamily;
        }
        if (mark.attrs?.fontSize) {
          const size = parseFontSize(mark.attrs.fontSize);
          if (size) options.size = size;
        }
        break;
      case 'link':
        // Handled at paragraph level
        break;
    }
  }

  // Apply admin default font/size when no explicit mark is set
  if (!options.font && _defaultFont) {
    options.font = _defaultFont;
  }
  if (!options.size && _defaultBodySize) {
    options.size = _defaultBodySize;
  }

  return new TextRun(options);
}

// ---------------------------------------------------------------------------
// Inline content conversion (paragraph children → TextRun[])
// ---------------------------------------------------------------------------

function convertInlineContent(nodes: TipTapNode[]): (TextRun | ExternalHyperlink)[] {
  const runs: (TextRun | ExternalHyperlink)[] = [];

  for (const node of nodes) {
    if (node.type === 'text') {
      const linkMark = node.marks?.find(m => m.type === 'link');
      if (linkMark?.attrs?.href) {
        runs.push(
          new ExternalHyperlink({
            children: [
              new TextRun({
                text: node.text || '',
                style: 'Hyperlink',
                font: _defaultFont || undefined,
                size: _defaultBodySize || undefined,
              }),
            ],
            link: linkMark.attrs.href,
          })
        );
      } else {
        runs.push(convertTextNode(node));
      }
    } else if (node.type === 'hardBreak') {
      runs.push(new TextRun({ break: 1 }));
    } else if (node.type === 'image') {
      const imgRun = createImageRun(node);
      if (imgRun) runs.push(imgRun);
    } else if (node.type === 'footnoteReference') {
      // Inline footnote reference — proper Word footnote
      const dataId = node.attrs?.['data-id'] || '';
      const fnId = _footnoteMap.get(dataId);
      if (fnId) {
        runs.push(new FootnoteReferenceRun(fnId));
      } else {
        runs.push(new TextRun({ text: '*', superScript: true, size: 18 }));
      }
    }
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Block node conversion
// ---------------------------------------------------------------------------

// Heading sizes in half-points — set dynamically by exportToDocx() from options
let _headingSizes: Record<number, number> = {
  1: 48,  // 24pt default
  2: 40,  // 20pt
  3: 32,  // 16pt
  4: 28,  // 14pt
  5: 24,  // 12pt
};

// Default body font size in half-points — set dynamically
let _defaultBodySize: number | undefined;

// Default font family — set dynamically
let _defaultFont: string | undefined;

// Paragraph spacing in twips — set dynamically
let _paraSpacing = { after: 240, line: 360 };

function convertBlockNode(node: TipTapNode, allContent?: TipTapNode[]): (Paragraph | Table)[] {
  const results: (Paragraph | Table)[] = [];

  switch (node.type) {
    case 'paragraph': {
      const children = node.content ? convertInlineContent(node.content) : [];
      const alignment = ALIGNMENT_MAP[node.attrs?.textAlign] || undefined;
      results.push(new Paragraph({
        children,
        alignment,
        spacing: _paraSpacing,
      }));
      break;
    }

    case 'heading': {
      const level = node.attrs?.level || 1;
      const alignment = ALIGNMENT_MAP[node.attrs?.textAlign] || undefined;
      const headingSize = _headingSizes[level] || 24;

      // Build heading TextRuns with forced bold + black + size
      const children: (TextRun | ExternalHyperlink)[] = [];
      for (const child of (node.content || [])) {
        if (child.type === 'text') {
          const marks = child.marks || [];
          const options: Record<string, any> = {
            text: child.text || '',
            bold: true,
            size: headingSize,
            color: '000000',
          };
          // Preserve italic/underline from marks
          for (const mark of marks) {
            if (mark.type === 'italic') options.italics = true;
            if (mark.type === 'underline') options.underline = {};
            if (mark.type === 'textStyle' && mark.attrs?.fontFamily) {
              options.font = mark.attrs.fontFamily;
            }
          }
          children.push(new TextRun(options));
        } else if (child.type === 'hardBreak') {
          children.push(new TextRun({ break: 1 }));
        }
      }

      if (children.length === 0) {
        children.push(new TextRun({ text: '', bold: true, size: headingSize, color: '000000' }));
      }

      results.push(
        new Paragraph({
          children,
          alignment,
          spacing: { before: 240, after: 120 },
        })
      );
      break;
    }

    case 'bulletList': {
      if (node.content) {
        for (const item of node.content) {
          if (item.type === 'listItem' && item.content) {
            for (const child of item.content) {
              const children = child.content ? convertInlineContent(child.content) : [];
              results.push(
                new Paragraph({
                  children,
                  bullet: { level: 0 },
                  spacing: { after: 120 },
                })
              );
            }
          }
        }
      }
      break;
    }

    case 'orderedList': {
      if (node.content) {
        for (const item of node.content) {
          if (item.type === 'listItem' && item.content) {
            for (const child of item.content) {
              const children = child.content ? convertInlineContent(child.content) : [];
              results.push(
                new Paragraph({
                  children,
                  numbering: { reference: 'default-numbering', level: 0 },
                  spacing: { after: 120 },
                })
              );
            }
          }
        }
      }
      break;
    }

    case 'table': {
      if (node.content) {
        const rows = node.content
          .filter(r => r.type === 'tableRow')
          .map(row => {
            const cells = (row.content || [])
              .filter(c => c.type === 'tableCell' || c.type === 'tableHeader')
              .map(cell => {
                const paragraphs = (cell.content || []).flatMap(c => convertBlockNode(c));
                return new TableCell({
                  children: paragraphs.length > 0 ? paragraphs : [new Paragraph({})],
                });
              });
            return new TableRow({ children: cells });
          });

        if (rows.length > 0) {
          results.push(
            new Table({
              rows,
              width: { size: 100, type: WidthType.PERCENTAGE },
            })
          );
        }
      }
      break;
    }

    case 'horizontalRule': {
      // Page break
      results.push(
        new Paragraph({
          children: [],
          pageBreakBefore: true,
        })
      );
      break;
    }

    case 'image': {
      const imgRun = createImageRun(node);
      if (imgRun) {
        const wrap = node.attrs?.wrapping || 'inline';
        results.push(
          new Paragraph({
            children: [imgRun],
            alignment: wrap === 'block' ? AlignmentType.CENTER : undefined,
            spacing: { after: 120 },
          })
        );
      }
      break;
    }

    case 'tableOfContents': {
      // Generate a static TOC from document headings
      results.push(new Paragraph({
        children: [new TextRun({ text: 'TABLE OF CONTENTS', bold: true, size: 28, color: '000000' })],
        alignment: AlignmentType.CENTER,
        spacing: { after: 240 },
      }));

      // Extract headings from document
      const maxDepth = node.attrs?.maxDepth || 3;
      const headings: Array<{ level: number; text: string }> = [];
      if (allContent) {
        for (const block of allContent) {
          if (block.type === 'heading') {
            const level = block.attrs?.level || 1;
            if (level <= maxDepth) {
              const text = block.content?.map(c => c.text || '').join('') || '';
              if (text.trim()) headings.push({ level, text: text.trim() });
            }
          }
        }
      }

      for (const h of headings) {
        const indent = convertInchesToTwip((h.level - 1) * 0.5);
        results.push(new Paragraph({
          children: [new TextRun({ text: h.text, size: 22, color: '000000' })],
          indent: { left: indent },
          spacing: { after: 60 },
        }));
      }

      if (headings.length > 0) {
        results.push(new Paragraph({ children: [], spacing: { after: 240 } }));
      }
      break;
    }

    case 'footnotes': {
      // Skip — footnotes are handled via Word's native footnote system
      // (extracted in extractFootnotes and passed to Document constructor)
      break;
    }

    case 'footnote': {
      // Skip — handled by extractFootnotes
      break;
    }

    case 'footnoteReference': {
      // Skip as block — handled inline in convertInlineContent
      break;
    }

    default: {
      // Try to convert content recursively for unknown nodes
      if (node.content) {
        for (const child of node.content) {
          results.push(...convertBlockNode(child, allContent));
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

// Extract footnotes from document, returning a map of data-id → footnote ID (1-based)
// and the footnotes config for the Document constructor
function extractFootnotes(content: TipTapNode[]): {
  footnoteMap: Map<string, number>;
  footnotesConfig: Record<number, { children: Paragraph[] }>;
} {
  const footnoteMap = new Map<string, number>();
  const footnotesConfig: Record<number, { children: Paragraph[] }> = {};
  let fnId = 1;

  // Find the footnotes container
  for (const node of content) {
    if (node.type === 'footnotes' && node.content) {
      for (const fn of node.content) {
        if (fn.type === 'footnote') {
          const dataId = fn.attrs?.['data-id'] || '';
          if (dataId) {
            footnoteMap.set(dataId, fnId);
            // Convert footnote content to paragraphs
            const children: Paragraph[] = [];
            for (const child of fn.content || []) {
              if (child.content) {
                children.push(new Paragraph({
                  children: convertInlineContent(child.content),
                  spacing: { after: 60 },
                }));
              }
            }
            if (children.length === 0) {
              children.push(new Paragraph({ children: [] }));
            }
            footnotesConfig[fnId] = { children };
            fnId++;
          }
        }
      }
    }
  }

  return { footnoteMap, footnotesConfig };
}

export async function exportToDocx(
  tiptapJson: Record<string, any>,
  options: ExportOptions = {}
): Promise<Blob> {
  const content = (tiptapJson.content || []) as TipTapNode[];

  // --- Apply style options to module-level config ---
  _headingSizes = {
    1: parseFontSize(options.h1Size) || 48,
    2: parseFontSize(options.h2Size) || 40,
    3: parseFontSize(options.h3Size) || 32,
    4: parseFontSize(options.h4Size) || 28,
    5: parseFontSize(options.h5Size) || 24,
  };
  _defaultBodySize = parseFontSize(options.defaultFontSize) || 24; // 24 half-pts = 12pt
  _defaultFont = options.defaultFont || 'Times New Roman';

  const lineMultiplier = parseFloat(options.lineSpacing || '1.5') || 1.5;
  const paraAfter = options.paragraphSpacing ? pxToTwip(parseFloat(options.paragraphSpacing)) : 240;
  _paraSpacing = { after: paraAfter, line: Math.round(lineMultiplier * 240) };

  // Extract footnotes first so inline references can use FootnoteReferenceRun
  const { footnoteMap, footnotesConfig } = extractFootnotes(content);
  // Store in module scope so convertInlineContent can access it
  _footnoteMap = footnoteMap;

  const paragraphs = content.flatMap(node => convertBlockNode(node, content));

  // Page size
  const PAGE_SIZES = {
    letter: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(11) },
    a4: { width: convertInchesToTwip(8.27), height: convertInchesToTwip(11.69) },
    legal: { width: convertInchesToTwip(8.5), height: convertInchesToTwip(14) },
  };
  const pageSize = PAGE_SIZES[options.pageSize || 'letter'] || PAGE_SIZES.letter;

  // Margins (convert px to twips)
  const margins = {
    top: pxToTwip(options.marginTop || 96),
    bottom: pxToTwip(options.marginBottom || 96),
    left: pxToTwip(options.marginLeft || 96),
    right: pxToTwip(options.marginRight || 96),
  };

  const doc = new Document({
    title: options.title || 'Document',
    footnotes: Object.keys(footnotesConfig).length > 0 ? footnotesConfig : undefined,
    styles: {
      default: {
        document: {
          run: {
            font: _defaultFont,
            size: _defaultBodySize,
          },
          paragraph: {
            spacing: _paraSpacing,
          },
        },
      },
    },
    numbering: {
      config: [
        {
          reference: 'default-numbering',
          levels: [
            {
              level: 0,
              format: LevelFormat.DECIMAL,
              text: '%1.',
              alignment: AlignmentType.LEFT,
            },
          ],
        },
      ],
    },
    sections: [
      {
        properties: {
          page: {
            size: pageSize,
            margin: margins,
          },
        },
        children: paragraphs,
      },
    ],
  });

  return Packer.toBlob(doc);
}
