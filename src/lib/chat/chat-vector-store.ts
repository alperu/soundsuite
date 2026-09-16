import { VectorStore } from '../vector/vector-store';

const LANCEDB_PATH = process.env.LANCEDB_PATH || './data/lancedb';

export function chatTableName(chatId: string): string {
  const safe = chatId.replace(/[^a-zA-Z0-9_]/g, '_');
  return `chunks_chat_${safe}`;
}

export async function getChatVectorStore(chatId: string): Promise<VectorStore> {
  const vs = new VectorStore({
    dbPath: LANCEDB_PATH,
    tableName: chatTableName(chatId),
  });
  await vs.initialize();
  return vs;
}

export async function dropChatTable(chatId: string): Promise<void> {
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(LANCEDB_PATH);
  const names = await db.tableNames();
  const name = chatTableName(chatId);
  if (names.includes(name)) {
    await db.dropTable(name);
  }
}

/**
 * Vector width of an existing chat table, from one sampled row. `null` when
 * the table does not exist or is empty — there is nothing to be incompatible
 * with in either case.
 */
export async function getChatTableVectorWidth(chatId: string): Promise<number | null> {
  const lancedb = await import('@lancedb/lancedb');
  const db = await lancedb.connect(LANCEDB_PATH);
  const name = chatTableName(chatId);
  if (!(await db.tableNames()).includes(name)) return null;
  try {
    const table = await db.openTable(name);
    const rows = await table.query().select(['vector']).limit(1).toArray();
    const width = rows[0]?.vector?.length;
    return typeof width === 'number' && width > 0 ? width : null;
  } catch {
    return null;
  }
}

export interface ChatTableWidthCheck {
  /** True when a stale table was dropped so it can be recreated at `width`. */
  recreated: boolean;
  /** The width the dropped table held; undefined when nothing was dropped. */
  previousWidth?: number;
}

/**
 * Make sure a chat's table can accept vectors of `width`, dropping it when it
 * cannot.
 *
 * Every chat table is created on its first insert, at whatever width the
 * embedding provider produced that day. When the corpus moved from
 * qwen3-embedding:0.6b (1024) to 4b (2560), 32 existing chat tables stayed at
 * 1024: searching them against a 2560 query hits VectorStore's dimension guard,
 * and attaching a new file to one of those chats fails at insert — a
 * fixed-size vector column cannot take a different width, and VectorStore's
 * schema-repair path only handles a MISSING column, never a wrong width.
 *
 * Dropping is safe here in a way it is not for the main corpus: a chat table
 * is only ever rebuilt from that chat's own attachments, which are still on
 * disk under data/chat-attachments/<chatId>/. The caller re-ingests them
 * after its own insert has created the table at the new width.
 */
export async function ensureChatTableWidth(chatId: string, width: number): Promise<ChatTableWidthCheck> {
  const existing = await getChatTableVectorWidth(chatId);
  if (existing === null || existing === width) return { recreated: false };
  await dropChatTable(chatId);
  return { recreated: true, previousWidth: existing };
}
