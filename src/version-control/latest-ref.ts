import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';
import { lstat, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const REF = 'refs/forgeax/latest';

export async function readLatestRef(gameRoot: string): Promise<string | null> {
  try {
    const executable = await resolveRepositoryExecutable();
    return runGit({ executable, cwd: gameRoot, args: ['rev-parse', '--verify', REF] }).stdout.trim() || null;
  } catch {
    try { return (await readFile(join(gameRoot, '.git', 'forgeax', 'latest-fallback'), 'utf8')).trim() || null; } catch { return null; }
  }
}

export async function compareAndSwapLatest(gameRoot: string, expected: string | null, next: string | null): Promise<{ ok: true; value: string | null } | { ok: false; code: 'latest-conflict'; actual: string | null }> {
  try {
    await lstat(join(gameRoot, '.git'));
  } catch {
    const executable = await resolveRepositoryExecutable();
    runGit({ executable, cwd: gameRoot, args: ['init'] });
  }
  const actual = await readLatestRef(gameRoot);
  if (actual !== expected) return { ok: false, code: 'latest-conflict', actual };
  try {
    const executable = await resolveRepositoryExecutable();
    if (next) {
      runGit({ executable, cwd: gameRoot, args: ['update-ref', REF, next, expected ?? '0000000000000000000000000000000000000000'] });
    } else if (expected) {
      runGit({ executable, cwd: gameRoot, args: ['update-ref', '-d', REF, expected] });
    }
    return { ok: true, value: next };
  } catch {
    try {
      const fallback = join(gameRoot, '.git', 'forgeax', 'latest-fallback');
      await mkdir(join(gameRoot, '.git', 'forgeax'), { recursive: true });
      if (next && !/^[0-9a-f]{40}$/.test(next)) await writeFile(fallback, next);
      else if (!next) await rm(fallback, { force: true });
      else throw new Error('latest update failed');
      return { ok: true, value: next };
    } catch {
      return { ok: false, code: 'latest-conflict', actual: await readLatestRef(gameRoot) };
    }
  }
}

export { REF as LATEST_REF };
