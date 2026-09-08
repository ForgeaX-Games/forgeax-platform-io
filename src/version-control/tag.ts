import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';

export interface TagRef { tag: string; commit: string; annotated: boolean; message: string }

export function validateTagName(tag: string): boolean {
  return typeof tag === 'string' && tag.length > 0 && !tag.includes('\0') && !tag.startsWith('-') && !tag.endsWith('.') && !tag.endsWith('/') && !tag.includes('..') && !/[ ~^:?*\\[\\]]/.test(tag);
}

export async function checkTagName(gameRoot: string, tag: string): Promise<boolean> {
  if (!validateTagName(tag)) return false;
  try {
    const executable = await resolveRepositoryExecutable();
    runGit({ executable, cwd: gameRoot, args: ['check-ref-format', `refs/tags/${tag}`] });
    return true;
  } catch { return false; }
}

export async function resolveTagCommit(gameRoot: string, tag: string): Promise<string | null> {
  if (!validateTagName(tag)) return null;
  try {
    const executable = await resolveRepositoryExecutable();
    return runGit({ executable, cwd: gameRoot, args: ['rev-parse', `${tag}^{commit}`] }).stdout.trim() || null;
  } catch { return null; }
}

export async function createAnnotatedTag(gameRoot: string, tag: string, message: string, expectedCommit: string): Promise<void> {
  if (!await checkTagName(gameRoot, tag)) throw new Error('Invalid Git tag name');
  const executable = await resolveRepositoryExecutable();
  const existing = await resolveTagCommit(gameRoot, tag);
  if (existing) throw new Error('Git tag already exists');
  runGit({ executable, cwd: gameRoot, args: ['-c', 'user.name=forgeax-game-host', '-c', 'user.email=game-host@forgeax.local', 'tag', '-a', tag, expectedCommit, '-m', message] });
}
