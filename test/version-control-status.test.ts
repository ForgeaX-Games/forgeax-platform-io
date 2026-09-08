import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readRepositorySnapshot, parsePorcelainV2, requireRepositorySnapshot } from '../src/version-control/status';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-status-'));
  roots.push(root);
  execFileSync('git', ['init', '--quiet', root]);
  execFileSync('git', ['-C', root, 'config', 'user.email', 'test@example.invalid']);
  execFileSync('git', ['-C', root, 'config', 'user.name', 'Test']);
  return root;
}

describe('version-control NUL status and snapshot', () => {
  test('preserves porcelain v2 records for ordinary and special paths', () => {
    const records = parsePorcelainV2(Buffer.from('1 .M N... 100644 100644 100644 a a file name\0? untracked\0', 'utf8'));
    expect(records.map((record) => record.kind)).toEqual(['modified', 'untracked']);
    expect(records[0]?.path).toBe('file name');
  });

  test('snapshot changes with tracked and untracked content', async () => {
    const root = repo();
    writeFileSync(join(root, 'tracked.txt'), 'one\n');
    execFileSync('git', ['-C', root, 'add', '.']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'initial', '--quiet']);
    const before = await readRepositorySnapshot(root);
    writeFileSync(join(root, 'new.txt'), 'two\n');
    writeFileSync(join(root, 'another.txt'), 'three\n');
    const after = await readRepositorySnapshot(root);
    expect(before.ok).toBe(true);
    expect(after.ok).toBe(true);
    if (before.ok && after.ok) expect(after.snapshotId).not.toBe(before.snapshotId);
  });

  test('classifies rename, conflict, deletion, and an uninitialized root', async () => {
    const records = parsePorcelainV2(
      '2 R. N... 100644 100644 100644 abc def R100 renamed.txt\0old name.txt\0'
      + 'u UU N... 100644 100644 100644 100644 abc def ghi conflicted.txt\0'
      + '1 .D N... 100644 100644 100644 abc abc deleted.txt\0',
    );
    expect(records.map((record) => record.kind)).toEqual(['renamed', 'conflicted', 'deleted']);
    expect(records[0]?.oldPath).toBe('old name.txt');
    const missing = await readRepositorySnapshot(join(tmpdir(), 'forgeax-no-such-repository'));
    expect(missing).toMatchObject({ ok: false, status: 'uninitialized' });
  });

  test('reports a faulted snapshot when a .git entry is not a usable repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-status-fault-'));
    roots.push(root);
    writeFileSync(join(root, '.git'), 'not a gitdir\n');
    await expect(readRepositorySnapshot(root)).resolves.toMatchObject({
      ok: false,
      status: 'faulted',
      code: 'version-control-status-failed',
    });
  });

  test('requireRepositorySnapshot exposes the structured failure boundary', async () => {
    const root = repo();
    const missing = mkdtempSync(join(tmpdir(), 'forgeax-require-missing-'));
    roots.push(missing);
    await expect(requireRepositorySnapshot(root)).resolves.toMatchObject({ ok: true });
    await expect(requireRepositorySnapshot(missing)).rejects.toThrow('uninitialized');
  });
});
