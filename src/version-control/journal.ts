import { mkdir, open, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

export interface JournalEntry {
  schemaVersion: 1;
  requestId: string;
  operation: string;
  payloadHash: string;
  stage: string;
  repositoryIdentity: string;
  beforeHead: string | null;
  result?: unknown;
  error?: unknown;
}

function journalPath(gameRoot: string): string { return join(gameRoot, '.git', 'forgeax', 'operation-journal.jsonl'); }

export async function appendJournalEntry(gameRoot: string, entry: JournalEntry): Promise<void> {
  const path = journalPath(gameRoot);
  await mkdir(dirname(path), { recursive: true });
  const handle = await open(path, 'a', 0o600);
  try {
    await handle.write(`${JSON.stringify(entry)}\n`);
    await handle.sync();
  } finally { await handle.close(); }
}

export async function replayJournal(gameRoot: string): Promise<JournalEntry[]> {
  try {
    const text = await readFile(journalPath(gameRoot), 'utf8');
    const entries: JournalEntry[] = [];
    for (const line of text.split('\n').filter(Boolean)) {
      try {
        const parsed = JSON.parse(line) as JournalEntry;
        if (parsed.schemaVersion === 1 && typeof parsed.requestId === 'string') entries.push(parsed);
      } catch { /* ignore torn final lines during recovery */ }
    }
    return entries;
  } catch { return []; }
}

export async function findJournalRequest(gameRoot: string, requestId: string, payloadHash: string): Promise<JournalEntry | 'conflict' | null> {
  const entries = await replayJournal(gameRoot);
  const found = entries.filter((entry) => entry.requestId === requestId).at(-1);
  if (!found) return null;
  return found.payloadHash === payloadHash ? found : 'conflict';
}
