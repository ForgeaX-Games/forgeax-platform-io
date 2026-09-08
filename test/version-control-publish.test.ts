import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeRepository } from '../src/version-control/init';
import { publishVersion } from '../src/version-control/publish';
import { readRepositorySnapshot } from '../src/version-control/status';
import { checkoutDetached } from '../src/version-control/checkout';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

describe('version-control publish and checkout', () => {
  test('publishes an arbitrary annotated tag and refuses stale snapshots', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-publish-'));
    try {
      await initializeRepository(root);
      writeFileSync(join(root, 'scene.json'), '{}\n');
      const preview = await readRepositorySnapshot(root);
      expect(preview.ok).toBe(true);
      if (!preview.ok) return;
      const result = await publishVersion(root, { tag: 'release/one', message: 'first', expectedSnapshotId: preview.snapshotId });
      expect(result.ok).toBe(true);
      writeFileSync(join(root, 'new.txt'), 'changed\n');
      const stale = await publishVersion(root, { tag: 'release/two', message: 'second', expectedSnapshotId: preview.snapshotId });
      expect(stale.ok).toBe(false);
      expect(git(root, ['tag', '--list'])).toContain('release/one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('detached checkout returns a receipt and preserves target identity', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-checkout-'));
    try {
      await initializeRepository(root);
      writeFileSync(join(root, 'scene.json'), 'one\n');
      const first = await readRepositorySnapshot(root);
      if (!first.ok) throw new Error('missing first snapshot');
      const published = await publishVersion(root, { tag: 'one', message: 'one', expectedSnapshotId: first.snapshotId });
      if (!published.ok) throw new Error('first publish failed');
      writeFileSync(join(root, 'scene.json'), 'two\n');
      const second = await readRepositorySnapshot(root);
      if (!second.ok) throw new Error('missing second snapshot');
      await publishVersion(root, { tag: 'two', message: 'two', expectedSnapshotId: second.snapshotId });
      const receipt = await checkoutDetached(root, { tag: 'one', expectedCommit: published.commitIdentity });
      expect(receipt.ok).toBe(true);
      expect(git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('HEAD');
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(published.commitIdentity);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('switches to the latest untagged commit through the explicit latest sentinel', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-checkout-latest-'));
    try {
      await initializeRepository(root);
      writeFileSync(join(root, 'scene.json'), 'tagged\n');
      const taggedSnapshot = await readRepositorySnapshot(root);
      if (!taggedSnapshot.ok) throw new Error('missing tagged snapshot');
      const tagged = await publishVersion(root, { tag: 'one', message: 'one', expectedSnapshotId: taggedSnapshot.snapshotId });
      if (!tagged.ok) throw new Error('tagged publish failed');
      writeFileSync(join(root, 'scene.json'), 'latest\n');
      git(root, ['add', '.']);
      git(root, ['-c', 'user.name=forgeax-test', '-c', 'user.email=test@example.invalid', 'commit', '--quiet', '-m', 'latest']);
      const latestCommit = git(root, ['rev-parse', 'HEAD']);
      const receipt = await checkoutDetached(root, { tag: '@latest', expectedCommit: latestCommit });
      expect(receipt.ok).toBe(true);
      if (receipt.ok) expect(receipt.receipt.targetTag).toBe('@latest');
      expect(git(root, ['rev-parse', 'HEAD'])).toBe(latestCommit);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
