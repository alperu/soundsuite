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
  // size is in px, convert to half-points
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
        type: 1, // square wrapping (TextWrappingType.SQUARE = 1 in docx)
        side: 3, // both sides (TextWrappingSide.BOTH_SIDES = 3)
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
    }
  }

  return runs;
}

// ---------------------------------------------------------------------------
// Block node conversion
// ---------------------------------------------------------------------------

// Heading sizes in half-points (Word units)
const HEADING_SIZES: Record<number, number> = {
  1: 48,  // 24pt
  2: 40,  // 20pt
  3: 32,  // 16pt
  4: 28,  // 14pt
  5: 24,  // 12pt
};

// Paragraph spacing in twips (240 twips = ~12pt after)
const PARA_SPACING = { after: 240 };

function convertBlockNode(node: TipTapNode): (Paragraph | Table)[] {
  const results: (Paragraph | Table)[] = [];

  switch (node.type) {
    case 'paragraph': {
      const children = node.content ? convertInlineContent(node.content) : [];
      const alignment = ALIGNMENT_MAP[node.attrs?.textAlign] || undefined;
      results.push(new Paragraph({
        children,
        alignment,
        spacing: PARA_SPACING,
      }));
      break;
    }

    case 'heading': {
      const level = node.attrs?.level || 1;
      const alignment = ALIGNMENT_MAP[node.attrs?.textAlign] || undefined;
      const headingSize = HEADING_SIZES[level] || 24;

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
                const paragraphs = (cell.content || []).flatMap(convertBlockNode);
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
        results.push(
          new Paragraph({
            children: [imgRun],
          })
        );
      }
      break;
    }

    case 'tableOfContents': {
      // Skip TOC node in export — Word has its own TOC
      results.push(
        new Paragraph({
          children: [new TextRun({ text: '[Table of Contents]', italics: true, color: '888888' })],
        })
      );
      break;
    }

    default: {
      // Try to convert content recursively for unknown nodes
      if (node.content) {
        for (const child of node.content) {
          results.push(...convertBlockNode(child));
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

export async function exportToDocx(
  tiptapJson: Record<string, any>,
  options: ExportOptions = {}
): Promise<Blob> {
  const content = (tiptapJson.content || []) as TipTapNode[];
  const paragraphs = content.flatMap(convertBlockNode);

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
