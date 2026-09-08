import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVersionGraph } from '../src/version-control/graph';
import { initializeRepository } from '../src/version-control/init';
import { publishVersion } from '../src/version-control/publish';
import { checkoutDetached } from '../src/version-control/checkout';
import { parsePorcelainV2, readRepositorySnapshot } from '../src/version-control/status';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

describe('game version-control owner integration', () => {
  test('detects, initializes, previews, publishes, graphs, switches, and recovers', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-vc-'));
    try {
      expect((await initializeRepository(root)).ok).toBe(true);
      const ignoreBefore = await Bun.file(join(root, '.gitignore')).text();
      expect((await initializeRepository(root)).ok).toBe(true);
      expect(await Bun.file(join(root, '.gitignore')).text()).toBe(ignoreBefore);
      writeFileSync(join(root, 'scene.json'), '{"version":1}\n');
      const first = await readRepositorySnapshot(root);
      if (!first.ok) throw new Error('first preview failed');
      const published = await publishVersion(root, { tag: 'release/one', message: 'one', expectedSnapshotId: first.snapshotId, requestId: 'publish-one' });
      if (!published.ok) throw published.error;
      const graph = await buildVersionGraph(root);
      expect(graph.nodes.some((node) => node.tags.includes('release/one'))).toBe(true);
      writeFileSync(join(root, 'scene.json'), '{"version":2}\n');
      const second = await readRepositorySnapshot(root);
      if (!second.ok) throw new Error('second preview failed');
      const secondPublish = await publishVersion(root, { tag: 'release/two', message: 'two', expectedSnapshotId: second.snapshotId });
      if (!secondPublish.ok) throw secondPublish.error;
      const switched = await checkoutDetached(root, { tag: 'release/one', expectedCommit: published.commitIdentity });
      expect(switched.ok).toBe(true);
      expect(await Bun.file(join(root, 'scene.json')).text()).toBe('{"version":1}\n');
      writeFileSync(join(root, 'scene.json'), '{"version":3}\n');
      git(root, ['add', 'scene.json']);
      git(root, ['config', 'user.name', 'ForgeaX Test']);
      git(root, ['config', 'user.email', 'test@example.invalid']);
      git(root, ['commit', '-m', 'unpublished tip']);
      const latestTip = git(root, ['rev-parse', 'HEAD']);
      const switchedLatest = await checkoutDetached(root, { tag: 'latest', expectedCommit: latestTip });
      expect(switchedLatest.ok).toBe(true);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  test('keeps the AC matrix grounded in the real repository owner', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-vc-matrix-'));
    try {
      const initialized = await initializeRepository(root);
      expect(initialized.ok).toBe(true);
      writeFileSync(join(root, 'scene one.json'), '{"version":1}\n');
      writeFileSync(join(root, '\u65e5\u672c\u8a9e.bin'), Buffer.from([0, 1, 2, 3]));
      writeFileSync(join(root, 'mode.txt'), 'mode\n');
      const first = await readRepositorySnapshot(root);
      expect(first.ok).toBe(true);
      if (!first.ok) return;
      expect(first.repository.path).toBe(root);
      expect(first.repositoryIdentity).toContain(root);
      expect(first.records.map((record) => record.kind)).toEqual(expect.arrayContaining(['untracked']));

      const published = await publishVersion(root, {
        tag: 'game/one',
        message: 'first matrix release',
        expectedSnapshotId: first.snapshotId,
        requestId: 'm5-ac-08',
      });
      expect(published.ok).toBe(true);
      if (!published.ok) return;
      expect(git(root, ['cat-file', '-t', `game/one^{tag}`])).toBe('tag');
      expect(git(root, ['rev-parse', 'game/one^{commit}'])).toBe(published.commitIdentity);

      writeFileSync(join(root, 'scene one.json'), '{"version":2}\n');
      git(root, ['mv', 'scene one.json', 'scene two.json']);
      git(root, ['rm', '\u65e5\u672c\u8a9e.bin']);
      chmodSync(join(root, 'mode.txt'), 0o755);
      const second = await readRepositorySnapshot(root);
      expect(second.ok).toBe(true);
      if (!second.ok) return;
      expect(second.records.map((record) => record.kind)).toEqual(expect.arrayContaining(['renamed', 'deleted']));
      expect(parsePorcelainV2('1 .T N... 100644 100755 100755 a a mode.txt')[0]?.kind).toBe('type-changed');
      expect(second.snapshotId).not.toBe(first.snapshotId);

      const stale = await publishVersion(root, {
        tag: 'game/two',
        message: 'stale matrix release',
        expectedSnapshotId: first.snapshotId,
        requestId: 'm5-ac-07',
      });
      expect(stale.ok).toBe(false);
      if (!stale.ok) expect(stale.error.code).toBe('version-control-snapshot-stale');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
