/**
 * Parses AI-generated text with [^N] footnote markers and [^N]: definitions
 * into structured content that can be inserted into TipTap with real footnotes.
 *
 * Input format:
 *   "The court erred.[^1] This is precedent.[^2]\n\n[^1]: Smith v. Jones, 801 S.W.2d at 109.\n[^2]: Record at p. 145."
 *
 * Output: { bodyHtml: string, footnotes: Array<{ id: string, content: string }> }
 */

export interface ParsedFootnote {
  marker: number;
  id: string;       // UUID for tiptap-footnotes data-id
  content: string;  // footnote text
}

export interface ParsedBriefContent {
  bodyHtml: string;            // HTML with footnote markers replaced by placeholder spans
  bodyText: string;            // Clean text without footnote markers (for preview)
  footnotes: ParsedFootnote[]; // Ordered footnote definitions
}

/**
 * Parse AI text with [^N] markers into body + footnotes.
 */
export function parseFootnoteMarkers(text: string): ParsedBriefContent {
  // Split text into body and footnote definitions
  // Footnote definitions are lines matching [^N]: ...
  const lines = text.split('\n');
  const bodyLines: string[] = [];
  const footnoteDefMap = new Map<number, string>();

  let inFootnoteDefs = false;

  for (const line of lines) {
    const fnDefMatch = line.match(/^\[\^(\d+)\]:\s*(.+)$/);
    if (fnDefMatch) {
      inFootnoteDefs = true;
      const num = parseInt(fnDefMatch[1], 10);
      footnoteDefMap.set(num, fnDefMatch[2].trim());
    } else if (inFootnoteDefs && line.trim() === '') {
      // Skip blank lines in footnote section
      continue;
    } else {
      inFootnoteDefs = false;
      bodyLines.push(line);
    }
  }

  const bodyText = bodyLines.join('\n').trim();

  // Find all [^N] references in the body
  const usedMarkers = new Set<number>();
  const markerRegex = /\[\^(\d+)\]/g;
  let match;
  while ((match = markerRegex.exec(bodyText)) !== null) {
    usedMarkers.add(parseInt(match[1], 10));
  }

  // Build footnotes array in order
  const footnotes: ParsedFootnote[] = [];
  const sortedMarkers = Array.from(usedMarkers).sort((a, b) => a - b);

  for (const num of sortedMarkers) {
    const content = footnoteDefMap.get(num) || `[Footnote ${num}]`;
    footnotes.push({
      marker: num,
      id: crypto.randomUUID(),
      content,
    });
  }

  // Build body HTML — replace [^N] with superscript spans
  // These will be converted to real footnotes by the insertion handler
  let bodyHtml = bodyText;

  // Convert markdown-style formatting to HTML
  bodyHtml = bodyHtml
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')  // bold
    .replace(/\*(.+?)\*/g, '<em>$1</em>');               // italic

  // Replace [^N] markers with superscript reference spans
  for (const fn of footnotes) {
    const marker = `[^${fn.marker}]`;
    bodyHtml = bodyHtml.split(marker).join(
      `<sup class="fn-marker" data-fn-id="${fn.id}" data-fn-num="${fn.marker}">${fn.marker}</sup>`
    );
  }

  // Convert paragraphs (double newlines) to <p> tags
  bodyHtml = bodyHtml
    .split(/\n\n+/)
    .map(para => para.trim())
    .filter(Boolean)
    .map(para => `<p>${para.replace(/\n/g, '<br>')}</p>`)
    .join('');

  // Clean body text (no markers)
  const cleanBodyText = bodyText.replace(/\[\^\d+\]/g, '').trim();

  return {
    bodyHtml,
    bodyText: cleanBodyText,
    footnotes,
  };
}

/**
 * Insert parsed brief content into a TipTap editor with real footnotes.
 *
 * @param editor - TipTap Editor instance
 * @param parsed - Output from parseFootnoteMarkers()
 */
export function insertBriefWithFootnotes(
  editor: any,
  parsed: ParsedBriefContent
): void {
  if (!editor || !parsed.footnotes.length) {
    // No footnotes — just insert as HTML
    editor?.commands?.insertContent(parsed.bodyHtml);
    return;
  }

  // Step 1: Insert the body HTML (with superscript placeholders, not real footnotes yet)
  editor.commands.insertContent(parsed.bodyHtml);

  // Step 2: For each footnote, add a real footnote via the editor command
  // The tiptap-footnotes extension manages footnote creation
  for (const fn of parsed.footnotes) {
    // Add footnote — this creates a footnoteReference at cursor and a footnote in the container
    (editor.commands as any).addFootnote?.();
  }

  // Step 3: We need to fill in the footnote content
  // The footnotes are at the bottom of the document in the footnotes container
  // We can find them and set their content via transactions
  setTimeout(() => {
    try {
      const { doc } = editor.state;
      const footnoteNodes: Array<{ pos: number; node: any }> = [];

      doc.descendants((node: any, pos: number) => {
        if (node.type.name === 'footnote') {
          footnoteNodes.push({ pos, node });
        }
      });

      // Fill the last N footnotes (the ones we just created) with content
      const startIdx = Math.max(0, footnoteNodes.length - parsed.footnotes.length);
      const { tr } = editor.state;

      for (let i = 0; i < parsed.footnotes.length; i++) {
        const fnNode = footnoteNodes[startIdx + i];
        if (!fnNode) continue;

        const fnContent = parsed.footnotes[i].content;
        // Create a paragraph node with the footnote text
        const paragraphNode = editor.state.schema.nodes.paragraph.create(
          null,
          editor.state.schema.text(fnContent)
        );

        // Replace the footnote's content
        const from = fnNode.pos + 1; // inside the footnote node
        const to = fnNode.pos + fnNode.node.nodeSize - 1;
        tr.replaceWith(from, to, paragraphNode);
      }

      editor.view.dispatch(tr);
    } catch (e) {
      console.warn('[Brief insert] Failed to fill footnote content:', e);
    }
  }, 100);
}
