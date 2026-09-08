import { createHash } from 'node:crypto';
import { inspectRepositoryRoot, type RepositoryIdentity } from './root';
import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';

export type StatusKind = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'type-changed' | 'conflicted';
export interface StatusRecord {
  kind: StatusKind;
  xy: string;
  path: string;
  oldPath?: string;
  indexMode?: string;
  worktreeMode?: string;
  score?: string;
}

function kindFor(xy: string, prefix: string): StatusKind {
  if (prefix === '2') return 'renamed';
  if (prefix === '?') return 'untracked';
  if (prefix === 'u') return 'conflicted';
  if (xy.includes('T')) return 'type-changed';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('A')) return 'added';
  return 'modified';
}

export function parsePorcelainV2(input: Uint8Array | string): StatusRecord[] {
  const text = typeof input === 'string' ? input : new TextDecoder().decode(input);
  const tokens = text.split('\0');
  const records: StatusRecord[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) continue;
    const prefix = token[0];
    if (prefix === '1') {
      const fields = token.split(' ');
      const xy = fields[1] ?? '??';
      records.push({ kind: kindFor(xy, prefix), xy, indexMode: fields[2], worktreeMode: fields[3], path: fields.slice(8).join(' ') });
    } else if (prefix === '2') {
      const fields = token.split(' ');
      const xy = fields[1] ?? '??';
      records.push({ kind: 'renamed', xy, score: fields[8], path: fields.slice(9).join(' '), oldPath: tokens[index + 1] ?? '' });
      index += 1;
    } else if (prefix === 'u') {
      const fields = token.split(' ');
      records.push({ kind: 'conflicted', xy: fields[1] ?? 'UU', path: fields.slice(10).join(' ') });
    } else if (prefix === '?') {
      records.push({ kind: 'untracked', xy: '??', path: token.slice(2) });
    }
  }
  return records;
}

export interface RepositorySnapshot {
  ok: true;
  repository: RepositoryIdentity;
  repositoryIdentity: string;
  head: string | null;
  records: readonly StatusRecord[];
  snapshotId: string;
  dirty: boolean;
}
export interface FaultedSnapshot {
  ok: false;
  status: 'faulted' | 'uninitialized';
  code: string;
  repositoryIdentity?: string;
  cause?: string;
}
export type SnapshotResult = RepositorySnapshot | FaultedSnapshot;

function snapshotHash(repositoryIdentity: string, head: string | null, records: readonly StatusRecord[]): string {
  const normalized = [...records].sort((a, b) => `${a.kind}\0${a.path}`.localeCompare(`${b.kind}\0${b.path}`));
  return createHash('sha256').update(JSON.stringify({ repositoryIdentity, head, records: normalized })).digest('hex');
}

export async function readRepositorySnapshot(gameRoot: string): Promise<SnapshotResult> {
  const inspected = await inspectRepositoryRoot(gameRoot);
  if (!inspected.ok) return { ok: false, status: 'uninitialized', code: inspected.code };
  try {
    const executable = await resolveRepositoryExecutable();
    let head: string | null = null;
    try { head = runGit({ executable, cwd: inspected.repository.path, args: ['rev-parse', '--verify', 'HEAD'] }).stdout.trim() || null; } catch { /* unborn HEAD is a valid repository state */ }
    const status = runGit({ executable, cwd: inspected.repository.path, args: ['status', '--porcelain=v2', '-z', '--untracked-files=all'] });
    const records = parsePorcelainV2(Buffer.from(status.stdout, 'utf8'));
    return {
      ok: true,
      repository: inspected.repository,
      repositoryIdentity: inspected.repository.identity,
      head,
      records,
      snapshotId: snapshotHash(inspected.repository.identity, head, records),
      dirty: records.length > 0,
    };
  } catch (error) {
    return { ok: false, status: 'faulted', code: 'version-control-status-failed', repositoryIdentity: inspected.repository.identity, cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512) };
  }
}

export async function requireRepositorySnapshot(gameRoot: string): Promise<RepositorySnapshot> {
  const result = await readRepositorySnapshot(gameRoot);
  if (!result.ok) throw new Error(`${result.code}: ${result.cause ?? 'repository status unavailable'}`);
  return result;
}
