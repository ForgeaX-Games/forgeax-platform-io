/** User-level registry of game directories mounted by Studio.
 *
 * This is deliberately a game registry, not a project/workspace registry. It
 * only exists so the dev Vite host can allow external game paths reached via a
 * runtime mount and so recent games can survive a process restart.
 */
import { homedir } from 'node:os';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export interface KnownGame {
  path: string;
  slug?: string;
  addedAt: number;
}

interface KnownGameStore { version: 1; games: KnownGame[] }

export function knownGamesFile(): string {
  return join(homedir(), '.forgeax', 'known-games.json');
}

function readStore(): KnownGameStore {
  const file = knownGamesFile();
  if (!existsSync(file)) return { version: 1, games: [] };
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf-8')) as Partial<KnownGameStore>;
    if (parsed.version !== 1 || !Array.isArray(parsed.games)) return { version: 1, games: [] };
    return {
      version: 1,
      games: parsed.games.filter((g): g is KnownGame =>
        !!g && typeof g.path === 'string' && typeof g.addedAt === 'number',
      ),
    };
  } catch {
    return { version: 1, games: [] };
  }
}

function writeStore(store: KnownGameStore): void {
  const file = knownGamesFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(store, null, 2) + '\n', 'utf-8');
}

export function loadKnownGames(): KnownGame[] {
  return readStore().games;
}

export function addKnownGame(path: string, slug?: string): KnownGame {
  const canonical = resolve(path);
  const store = readStore();
  const existing = store.games.find((g) => g.path === canonical);
  if (existing) {
    if (slug && existing.slug !== slug) existing.slug = slug;
    writeStore(store);
    return existing;
  }
  const entry: KnownGame = { path: canonical, addedAt: Date.now(), ...(slug ? { slug } : {}) };
  store.games.push(entry);
  writeStore(store);
  return entry;
}

export function removeKnownGame(path: string): boolean {
  const canonical = resolve(path);
  const store = readStore();
  const before = store.games.length;
  store.games = store.games.filter((g) => g.path !== canonical);
  if (store.games.length === before) return false;
  writeStore(store);
  return true;
}
