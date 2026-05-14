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
