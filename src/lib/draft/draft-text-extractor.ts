/**
 * Extract plain text from TipTap JSON document.
 * Recursively traverses all nodes, concatenates text content.
 */
export function extractTextFromTiptap(content: string): string {
  // If empty, return empty
  if (!content) return '';

  // Try to parse as JSON
  let doc: any;
  try {
    doc = typeof content === 'string' ? JSON.parse(content) : content;
  } catch {
    // Not JSON — return as-is (plain text)
    return content;
  }

  // Recursively extract text from node tree
  return extractFromNode(doc).trim();
}

function extractFromNode(node: any): string {
  if (!node) return '';

  // Text node
  if (node.type === 'text' && node.text) return node.text;

  // Hard break
  if (node.type === 'hardBreak') return '\n';

  // Horizontal rule (page break)
  if (node.type === 'horizontalRule') return '\n---\n';

  // Skip footnotes container and TOC nodes
  if (node.type === 'footnotes' || node.type === 'tableOfContents') return '';

  // Block nodes: add newlines between children
  if (node.content && Array.isArray(node.content)) {
    const childTexts = node.content.map(extractFromNode).filter(Boolean);

    // Block-level nodes get double newlines
    const isBlock = ['paragraph', 'heading', 'bulletList', 'orderedList', 'listItem', 'blockquote', 'table'].includes(node.type);
    return childTexts.join(isBlock ? '\n\n' : '');
  }

  return '';
}
