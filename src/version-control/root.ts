import { lstatSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { resolveGitExecutable } from './executable';

export interface RepositoryIdentity {
  path: string;
  realPath: string;
  gitDir: string;
  identity: string;
}
export type RepositoryRootResult = { ok: true; repository: RepositoryIdentity; realPath: string } | { ok: false; code: 'uninitialized' | 'root-mismatch' | 'invalid-root'; path: string };

export async function inspectRepositoryRoot(gameRoot: string): Promise<RepositoryRootResult> {
  const path = resolve(gameRoot);
  let realPath: string;
  try { realPath = realpathSync(path); } catch { return { ok: false, code: 'invalid-root', path }; }
  try {
    const gitEntry = lstatSync(join(path, '.git'));
    if (!gitEntry.isDirectory() && !gitEntry.isFile()) return { ok: false, code: 'invalid-root', path };
  } catch { return { ok: false, code: 'uninitialized', path }; }
  const gitDir = join(path, '.git');
  return {
    ok: true,
    realPath,
    repository: { path, realPath, gitDir, identity: `${realPath}\0${realpathSync(gitDir)}` },
  };
}

export async function assertCanonicalRepositoryRoot(gameRoot: string): Promise<RepositoryIdentity> {
  const result = await inspectRepositoryRoot(gameRoot);
  if (!result.ok) throw new Error(`Repository root is not initialized: ${result.code}`);
  return result.repository;
}

export async function resolveRepositoryExecutable(): Promise<string> {
  const result = await resolveGitExecutable();
  if (!result.ok) throw new Error('Git executable is unavailable');
  return result.path;
}
