import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { initializeRepository } from './init';
import { listTagRefs } from './graph';
import { publishVersion } from './publish';
import { readRepositorySnapshot } from './status';
import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';

const PACKAGE_FILES = ['project.json', 'blueprint.json', 'assets/manifest.json'] as const;

export interface CreatedVersion { tag: string | null; commitHash: string | null; unchanged?: boolean }
export interface CreatedCheckpoint { commitHash: string; message: string; createdAt: string; created: boolean }
export interface CurrentVersion { tag: string | null; commitHash: string | null; dirty: boolean }
export interface VersionEntry { tag: string; commitHash: string; createdAt: number; message: string }

export async function ensureGameRepository(dir: string): Promise<void> {
  await initializeRepository(dir);
}

export async function createVersion(dir: string, message?: string): Promise<CreatedVersion> {
  await initializeRepository(dir);
  const snapshot = await readRepositorySnapshot(dir);
  if (!snapshot.ok) throw new Error(snapshot.code);
  const refs = await listTagRefs(dir);
  const versionNumbers = refs.map((ref) => /^v(\d+)$/.exec(ref.tag)?.[1]).filter(Boolean).map(Number);
  const nextTag = `v${(versionNumbers.length ? Math.max(...versionNumbers) : 0) + 1}`;
  const current = refs.find((ref) => ref.commit === snapshot.head)?.tag;
  if (!snapshot.dirty && current) return { tag: current, commitHash: snapshot.head, unchanged: true };
  const published = await publishVersion(dir, {
    tag: nextTag,
    message: message ?? `[game-host] ${nextTag}`,
    expectedSnapshotId: snapshot.snapshotId,
    requestId: `compat-${nextTag}-${snapshot.snapshotId.slice(0, 12)}`,
  });
  if (!published.ok) throw published.error;
  return { tag: published.tag, commitHash: published.commitIdentity };
}

export async function createCheckpoint(dir: string, message: string): Promise<CreatedCheckpoint> {
  await initializeRepository(dir);
  for (const relativePath of PACKAGE_FILES) {
    const details = await lstat(resolve(dir, relativePath));
    if (!details.isFile() || details.isSymbolicLink()) throw new TypeError(`Package path must be a regular file: ${relativePath}`);
  }
  const executable = await resolveRepositoryExecutable();
  runGit({ executable, cwd: dir, args: ['add', '--', ...PACKAGE_FILES] });
  const staged = runGit({ executable, cwd: dir, args: ['diff', '--cached', '--name-only', '--', ...PACKAGE_FILES] }).stdout.trim().length > 0;
  const head = (() => { try { return runGit({ executable, cwd: dir, args: ['rev-parse', 'HEAD'] }).stdout.trim(); } catch { return ''; } })();
  if (head && !staged) return { commitHash: head, message, createdAt: runGit({ executable, cwd: dir, args: ['show', '-s', '--format=%cI', head] }).stdout.trim(), created: false };
  runGit({ executable, cwd: dir, args: ['-c', 'user.name=forgeax-game-host', '-c', 'user.email=game-host@forgeax.local', 'commit', '--only', '-m', message, '--', ...PACKAGE_FILES] });
  const commitHash = runGit({ executable, cwd: dir, args: ['rev-parse', 'HEAD'] }).stdout.trim();
  return { commitHash, message, createdAt: runGit({ executable, cwd: dir, args: ['show', '-s', '--format=%cI', commitHash] }).stdout.trim(), created: true };
}

export async function listVersions(dir: string): Promise<VersionEntry[]> {
  const refs = await listTagRefs(dir);
  return refs.filter((ref) => /^v\d+$/.test(ref.tag)).map((ref) => ({ tag: ref.tag, commitHash: ref.commit, createdAt: 0, message: ref.message })).sort((a, b) => Number(b.tag.slice(1)) - Number(a.tag.slice(1)));
}

export async function readPackageAtTag(dir: string, tag: string): Promise<{ project: unknown | null; blueprint: unknown | null; assetsManifest: unknown | null } | null> {
  if (!/^v\d+$/.test(tag)) return null;
  const executable = await resolveRepositoryExecutable();
  try { runGit({ executable, cwd: dir, args: ['rev-parse', `${tag}^{}`] }); } catch { return null; }
  const show = async (file: string): Promise<unknown | null> => {
    try { const raw = runGit({ executable, cwd: dir, args: ['show', `${tag}:${file}`] }).stdout; return raw ? JSON.parse(raw) : null; } catch { return null; }
  };
  return { project: await show(PACKAGE_FILES[0]), blueprint: await show(PACKAGE_FILES[1]), assetsManifest: await show(PACKAGE_FILES[2]) };
}

export async function currentVersion(dir: string): Promise<CurrentVersion> {
  const snapshot = await readRepositorySnapshot(dir);
  if (!snapshot.ok) return { tag: null, commitHash: null, dirty: false };
  const versions = await listVersions(dir);
  return { tag: versions.find((version) => version.commitHash === snapshot.head)?.tag ?? null, commitHash: snapshot.head, dirty: snapshot.dirty };
}

export async function readGameFileAtTag(dir: string, tag: string, relativePath: string): Promise<Uint8Array | null> {
  if (!/^v\d+$/.test(tag) || !relativePath || relativePath.startsWith('/') || relativePath.includes('\\') || relativePath.includes('\0') || relativePath.split('/').some((segment) => !segment || segment === '.' || segment === '..')) throw new TypeError('Version file must be a bounded relative path');
  const executable = await resolveRepositoryExecutable();
  try { return new TextEncoder().encode(runGit({ executable, cwd: dir, args: ['show', `${tag}:${relativePath}`] }).stdout); } catch { return null; }
}
