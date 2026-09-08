import { mkdir, writeFile } from 'node:fs/promises';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';

export const RUNTIME_IGNORES = [
  'sessions/',
  'assets/.uploads/',
  '*.log',
  'node_modules/',
  '.DS_Store',
  '.forgeax/ddc/',
] as const;
export interface InitializeResult { ok: true; initialized: boolean; ignoreChanged: boolean; repositoryPath: string; status: 'ready'; preview: 'available' }

async function ensureIgnore(root: string): Promise<boolean> {
  const path = join(root, '.gitignore');
  let existing = '';
  try { existing = await Bun.file(path).text(); } catch { /* create below */ }
  const present = new Set(existing.split(/\r?\n/).map((line) => line.trim()).filter(Boolean));
  const missing = RUNTIME_IGNORES.filter((entry) => !present.has(entry));
  if (!missing.length) return false;
  const prefix = existing ? existing.replace(/\s*$/, '') + '\n' : '# forgeax runtime state\n';
  await writeFile(path, prefix + missing.join('\n') + '\n');
  return true;
}

export async function initializeRepository(gameRoot: string): Promise<InitializeResult> {
  await mkdir(gameRoot, { recursive: true });
  let initialized = false;
  try { await lstat(join(gameRoot, '.git')); } catch {
    const executable = await resolveRepositoryExecutable();
    runGit({ executable, cwd: gameRoot, args: ['init'] });
    initialized = true;
  }
  const ignoreChanged = await ensureIgnore(gameRoot);
  if (!initialized) {
    try {
      const executable = await resolveRepositoryExecutable();
      runGit({ executable, cwd: gameRoot, args: ['rm', '-r', '--cached', '--ignore-unmatch', 'sessions', 'assets/.uploads'] });
    } catch { /* no tracked runtime state is the normal case */ }
  }
  return { ok: true, initialized, ignoreChanged, repositoryPath: gameRoot, status: 'ready', preview: 'available' };
}
