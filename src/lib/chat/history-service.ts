import fs from 'fs/promises';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: 'user' | 'assistant';
  content: string;
  mode?: 'ai' | 'deep' | 'compare';
  /** Provider/model that produced THIS turn, stamped at submit time. The
   *  session-level fields are only a "most recent" hint — a conversation can
   *  mix models and modes turn by turn. */
  provider?: string;
  model?: string;
  searchTime?: number | null;
  sources?: Array<{
    text: string;
    document: string;
    page: number;
    citation?: string;
    citationShort?: string;
  }>;
  searchStats?: {
    totalRetrieved?: number;
    uniqueAfterDedup?: number;
    finalAfterRerank?: number;
    subQueryCount?: number;
  };
  subQueries?: string[];
  /**
   * Research trace for this turn (evidence-gathering narration, model
   * reasoning, anything split off the front of the answer). Stored as plain
   * text inside a fenced block — it can contain raw excerpt text with its own
   * `---`, `##` and `<details>` lookalikes, so it must never be re-parsed as
   * markdown on the way back in.
   */
  thoughts?: string;
}

export interface ChatSessionMeta {
  id: string;
  caseNumber?: string;
  caseId?: string;
  mode: 'ai' | 'deep' | 'compare';
  provider: string;
  model: string;
  createdAt: string;
  updatedAt: string;
  firstQuery: string;
  turnCount: number;
}

export interface ChatSession extends ChatSessionMeta {
  turns: ChatTurn[];
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DATA_DIR = path.join(process.cwd(), 'data', 'chat', 'history');

function sessionDir(caseNumber?: string): string {
  if (caseNumber) {
    return path.join(DATA_DIR, caseNumber.replace(/[^a-zA-Z0-9_-]/g, '_'));
  }
  return path.join(DATA_DIR, '_general');
}

function sessionFilePath(id: string, caseNumber?: string): string {
  return path.join(sessionDir(caseNumber), `${id}.md`);
}

// ---------------------------------------------------------------------------
// Markdown serialization
// ---------------------------------------------------------------------------

/**
 * Fence for the persisted thoughts trace. Six tildes rather than the usual
 * three: the payload is raw retrieved text and model reasoning, which routinely
 * contains code fences, `---` rules and `##` headings of its own. Only a line
 * that is *nothing but* four-or-more tildes could close it early, and
 * {@link escapeThoughts} indents those out of the way.
 */
const THOUGHTS_FENCE = '~~~~~~';

function escapeThoughts(text: string): string {
  return text.replace(/^(~{4,})[ \t]*$/gm, ' $1');
}

function unescapeThoughts(text: string): string {
  return text.replace(/^ (~{4,})[ \t]*$/gm, '$1');
}

export function toMarkdown(session: ChatSession): string {
  const frontmatter = [
    '---',
    `id: ${session.id}`,
    `mode: ${session.mode}`,
    `provider: ${session.provider}`,
    `model: ${session.model}`,
    `createdAt: ${session.createdAt}`,
    `updatedAt: ${session.updatedAt}`,
    ...(session.caseNumber ? [`caseNumber: ${session.caseNumber}`] : []),
    ...(session.caseId ? [`caseId: ${session.caseId}`] : []),
    '---',
    '',
  ].join('\n');

  const turns = session.turns.map((turn, i) => {
    const heading = turn.role === 'user' ? `## User` : `## Assistant`;
    const meta: string[] = [];
    if (turn.mode) meta.push(`mode: ${turn.mode}`);
    if (turn.provider) meta.push(`provider: ${turn.provider}`);
    if (turn.model) meta.push(`model: ${turn.model}`);
    if (turn.searchTime != null) meta.push(`searchTime: ${turn.searchTime}ms`);

    let content = `${heading}\n\n${turn.content}`;
    if (meta.length > 0) content += `\n\n<!-- ${meta.join(' | ')} -->`;

    if (turn.thoughts && turn.thoughts.trim()) {
      content += `\n\n<details><summary>Thoughts</summary>\n\n${THOUGHTS_FENCE}\n${escapeThoughts(turn.thoughts)}\n${THOUGHTS_FENCE}\n\n</details>`;
    }

    if (turn.searchStats) {
      const st = turn.searchStats;
      content += `\n\n<!-- stats: ${st.subQueryCount || 0} sub-queries, ${st.totalRetrieved || 0} retrieved, ${st.uniqueAfterDedup || 0} unique, ${st.finalAfterRerank || 0} after rerank -->`;
    }

    if (turn.subQueries && turn.subQueries.length > 0) {
      content += '\n\n<details><summary>Sub-queries</summary>\n\n';
      for (const sq of turn.subQueries) {
        content += `- ${sq}\n`;
      }
      content += '\n</details>';
    }

    if (turn.sources && turn.sources.length > 0) {
      // Neutralize any literal <details>/<summary> tags inside source text or
      // citations — an embedded "</details>" would otherwise close this block
      // early and corrupt both the displayed message and the sources list on
      // load. Previews are lossy already (200-char slice), so stripping the
      // tag substring is fine.
      const safe = (str: string) => str.replace(/<\/?(?:details|summary)>/gi, '');
      content += '\n\n<details><summary>Sources</summary>\n\n';
      for (const s of turn.sources) {
        const cite = safe(s.citation || s.citationShort || `${s.document}, p.${s.page}`);
        const preview = safe(s.text.slice(0, 200)) + (s.text.length > 200 ? '...' : '');
        content += `- **${cite}**: ${preview}\n`;
      }
      content += '\n</details>';
    }

    return content;
  }).join('\n\n---\n\n');

  return frontmatter + turns + '\n';
}

function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!match) return { meta: {}, body: content };
  const meta: Record<string, string> = {};
  for (const line of match[1].split('\n')) {
    const idx = line.indexOf(':');
    if (idx > 0) {
      meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
    }
  }
  return { meta, body: match[2] };
}

export function fromMarkdown(content: string, fileName: string): ChatSession {
  const { meta, body } = parseFrontmatter(content);

  const turns: ChatTurn[] = [];
  // Only split at real turn boundaries. toMarkdown joins turns with "\n\n---\n\n"
  // followed by "## User" or "## Assistant". A plain "---" horizontal rule inside
  // a response body would previously fragment the turn and drop everything after
  // the first rule (loads only kept sections starting with the two headings).
  const sections = body.split(/\n\n---\n\n(?=## (?:User|Assistant)\n)/).map(s => s.trim()).filter(Boolean);

  for (const section of sections) {
    const isUser = section.startsWith('## User');
    const isAssistant = section.startsWith('## Assistant');
    if (!isUser && !isAssistant) continue;

    // Remove heading line
    let text = section.replace(/^## (?:User|Assistant)\s*\n/, '').trim();

    // Extract metadata comment
    let mode: string | undefined;
    let provider: string | undefined;
    let model: string | undefined;
    let searchTime: number | undefined;
    const metaMatch = text.match(/<!-- (.+?) -->/);
    if (metaMatch) {
      text = text.replace(/\n*<!-- .+? -->/, '').trim();
      for (const part of metaMatch[1].split('|').map(s => s.trim())) {
        if (part.startsWith('mode:')) mode = part.slice(5).trim();
        if (part.startsWith('provider:')) provider = part.slice(9).trim();
        if (part.startsWith('model:')) model = part.slice(6).trim();
        if (part.startsWith('searchTime:')) searchTime = parseInt(part.slice(11).trim());
      }
    }

    // Extract structured data from the markdown-serialized metadata blocks
    // before stripping them, so loadSession can restore the full UI state.
    let sources: ChatTurn['sources'];
    let subQueries: ChatTurn['subQueries'];
    let searchStats: ChatTurn['searchStats'];
    let thoughts: ChatTurn['thoughts'];

    if (isAssistant) {
      // Thoughts: fenced, so the trace's own markdown can't terminate it early.
      // Sessions written before thoughts existed simply have no block here.
      const thoughtsBlock = new RegExp(
        `\\n*<details><summary>Thoughts</summary>\\s*\\n${THOUGHTS_FENCE}\\n([\\s\\S]*?)\\n${THOUGHTS_FENCE}\\n\\s*</details>`,
      );
      const thoughtsMatch = text.match(thoughtsBlock);
      if (thoughtsMatch) {
        thoughts = unescapeThoughts(thoughtsMatch[1]);
        // Take the block out of `text` before anything else reads it. The trace
        // is arbitrary retrieved content and routinely contains stats-comment
        // and <details> lookalikes that would otherwise be picked up as this
        // turn's real metadata.
        text = text.replace(thoughtsBlock, '');
      }

      // Stats comment: <!-- stats: 4 sub-queries, 100 retrieved, 75 unique, 75 after rerank -->
      const statsMatch = text.match(/<!-- stats: (\d+) sub-queries?, (\d+) retrieved, (\d+) unique, (\d+) after rerank -->/);
      if (statsMatch) {
        searchStats = {
          subQueryCount: parseInt(statsMatch[1]),
          totalRetrieved: parseInt(statsMatch[2]),
          uniqueAfterDedup: parseInt(statsMatch[3]),
          finalAfterRerank: parseInt(statsMatch[4]),
        };
      }

      // Sub-queries: <details><summary>Sub-queries</summary>\n\n- q1\n- q2\n</details>
      const sqMatch = text.match(/<details><summary>Sub-queries<\/summary>\s*\n([\s\S]*?)\n<\/details>/);
      if (sqMatch) {
        subQueries = sqMatch[1].split('\n').filter(l => l.startsWith('- ')).map(l => l.slice(2).trim());
      }

      // Sources: <details><summary>Sources</summary>\n\n- **cite**: text...\n</details>
      // toMarkdown always appends Sources LAST, so capture to end-of-section
      // rather than to the first "</details>": a source preview can itself
      // contain a literal "</details>" (e.g. extracted from a PDF chunk), which
      // would otherwise close the block early and truncate the sources list.
      // The "- **" line filter below discards any stray non-source lines.
      const srcMatch = text.match(/<details><summary>Sources<\/summary>\s*\n([\s\S]*)$/);
      if (srcMatch) {
        sources = srcMatch[1].split('\n').filter(l => l.startsWith('- **')).map(l => {
          const m = l.match(/^- \*\*(.+?)\*\*: (.+)$/);
          return m ? { text: m[2].replace(/\.\.\.$/,''), document: '', page: 0, citation: m[1] } : { text: l.slice(2), document: '', page: 0 };
        });
      }
    }

    // Strip the trailing metadata blocks from the displayed content. toMarkdown
    // appends them in a fixed order after the answer body: the stats comment,
    // then the Sub-queries <details>, then the Sources <details>. So strip from
    // the FIRST such marker to end-of-section in one shot. Do NOT use a bare
    // /<details>...<\/details>/ match — a source preview can contain a literal
    // "</details>" that closes the block early and leaks the rest of the source
    // dump back into the visible message (the bug this replaces). Anchoring on
    // the specific <summary> labels also avoids eating a legitimate bare
    // <details> the model may have written inside its answer.
    // Thoughts is serialized first among the trailing blocks, so stripping from
    // it also removes everything after — all of which has already been
    // extracted above.
    text = text.replace(/\n*<details><summary>Thoughts<\/summary>[\s\S]*$/, '').trim();
    text = text.replace(/\n*<!-- stats:[\s\S]*$/, '').trim();
    text = text.replace(/\n*<details><summary>(?:Sub-queries|Sources)<\/summary>[\s\S]*$/, '').trim();

    turns.push({
      role: isUser ? 'user' : 'assistant',
      content: text,
      ...(mode ? { mode: mode as ChatTurn['mode'] } : {}),
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(searchTime != null ? { searchTime } : {}),
      ...(sources ? { sources } : {}),
      ...(subQueries ? { subQueries } : {}),
      ...(searchStats ? { searchStats } : {}),
      ...(thoughts ? { thoughts } : {}),
    });
  }

  return {
    id: meta.id || fileName.replace('.md', ''),
    mode: (meta.mode as ChatSession['mode']) || 'ai',
    provider: meta.provider || '',
    model: meta.model || '',
    caseNumber: meta.caseNumber,
    caseId: meta.caseId,
    createdAt: meta.createdAt || new Date().toISOString(),
    updatedAt: meta.updatedAt || new Date().toISOString(),
    firstQuery: turns.find(t => t.role === 'user')?.content.slice(0, 100) || '',
    turnCount: turns.length,
    turns,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function saveSession(session: ChatSession): Promise<void> {
  const dir = sessionDir(session.caseNumber);
  await fs.mkdir(dir, { recursive: true });
  const filePath = sessionFilePath(session.id, session.caseNumber);
  await fs.writeFile(filePath, toMarkdown(session), 'utf-8');

  // Case scope no longer resets the chat, so a session's caseNumber can change
  // mid-conversation — which changes its directory. Remove any stale copy of
  // the same id in another directory or the history list shows duplicates.
  async function removeStale(dir: string): Promise<void> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) await removeStale(full);
        else if (entry.name === `${session.id}.md` && full !== filePath) {
          await fs.unlink(full).catch(() => {});
        }
      }
    } catch { /* dir doesn't exist */ }
  }
  await removeStale(DATA_DIR);
}

export async function listSessions(caseNumber?: string): Promise<ChatSessionMeta[]> {
  const results: ChatSessionMeta[] = [];

  async function scanDir(dir: string) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          await scanDir(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.md')) {
          try {
            const content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
            const session = fromMarkdown(content, entry.name);
            results.push({
              id: session.id,
              caseNumber: session.caseNumber,
              caseId: session.caseId,
              mode: session.mode,
              provider: session.provider,
              model: session.model,
              createdAt: session.createdAt,
              updatedAt: session.updatedAt,
              firstQuery: session.firstQuery,
              turnCount: session.turnCount,
            });
          } catch { /* skip malformed files */ }
        }
      }
    } catch {
      // Directory doesn't exist yet
    }
  }

  if (caseNumber) {
    await scanDir(sessionDir(caseNumber));
  } else {
    await scanDir(DATA_DIR);
  }

  // Sort newest first
  results.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return results;
}

export async function loadSession(id: string, caseNumber?: string): Promise<ChatSession | null> {
  // If caseNumber provided, look there first
  if (caseNumber) {
    const filePath = sessionFilePath(id, caseNumber);
    try {
      const content = await fs.readFile(filePath, 'utf-8');
      return fromMarkdown(content, `${id}.md`);
    } catch { /* not found */ }
  }

  // Search all directories
  async function searchDir(dir: string): Promise<ChatSession | null> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const result = await searchDir(path.join(dir, entry.name));
          if (result) return result;
        } else if (entry.name === `${id}.md`) {
          const content = await fs.readFile(path.join(dir, entry.name), 'utf-8');
          return fromMarkdown(content, entry.name);
        }
      }
    } catch { /* dir doesn't exist */ }
    return null;
  }

  return searchDir(DATA_DIR);
}

export async function deleteSession(id: string, caseNumber?: string): Promise<boolean> {
  // Try specific case dir first
  if (caseNumber) {
    try {
      await fs.unlink(sessionFilePath(id, caseNumber));
      return true;
    } catch { /* not there */ }
  }

  // Search all
  async function searchAndDelete(dir: string): Promise<boolean> {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (await searchAndDelete(path.join(dir, entry.name))) return true;
        } else if (entry.name === `${id}.md`) {
          await fs.unlink(path.join(dir, entry.name));
          return true;
        }
      }
    } catch { /* dir doesn't exist */ }
    return false;
  }

  return searchAndDelete(DATA_DIR);
}

export async function archiveSessions(ids: string[]): Promise<Buffer> {
  // Simple concatenation of all session markdowns into a single buffer
  // A proper zip can be added later if needed
  const parts: string[] = [];
  for (const id of ids) {
    const session = await loadSession(id);
    if (session) {
      parts.push(toMarkdown(session));
    }
  }
  return Buffer.from(parts.join('\n\n========================================\n\n'), 'utf-8');
}
