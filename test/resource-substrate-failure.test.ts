import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import type { ResourceRoot } from '../src/resource-substrate/contract';
import type { FilesystemStoreFailpoint } from '../src/resource-substrate/storage';

const durableFailpoints: readonly FilesystemStoreFailpoint[] = [
  'blob-write',
  'blob-fsync',
  'manifest-write',
  'manifest-fsync',
  'prepared-write',
  'prepared-fsync',
  'head-replace',
  'head-fsync',
  'terminal-write',
  'terminal-fsync',
];

async function openRoot(): Promise<{
  root: ResourceRoot;
  directory: string;
  store: ReturnType<typeof createFilesystemResourceStore>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-failure-'));
  const store = createFilesystemResourceStore({ directory });
  const opened = await openResourceRoot({ rootId: 'game-main', store });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, directory, store };
}

async function seed(root: ResourceRoot) {
  const before = await root.readSnapshot();
  expect(before.ok).toBe(true);
  if (!before.ok) throw before.error;
  const result = await root.commit({
    identity: 'failure-seed',
    expectedRevision: before.value.revision,
    changes: [{ kind: 'put', resourceId: 'assets/seed.bin', bytes: Uint8Array.from([1]) }],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return root.readSnapshot();
}

describe('filesystem persistence failure matrix', () => {
  for (const failpoint of durableFailpoints) {
    test(`converges after ${failpoint} failure`, async () => {
      const opened = await openRoot();
      try {
        const before = await seed(opened.root);
        expect(before.ok).toBe(true);
        if (!before.ok) throw before.error;

        const request = {
          identity: `failure-${failpoint}`,
          expectedRevision: before.value.revision,
          changes: [
            { kind: 'put' as const, resourceId: 'assets/a.bin', bytes: Uint8Array.from([2, 3]) },
            { kind: 'put' as const, resourceId: 'assets/b.bin', bytes: Uint8Array.from([4, 5]) },
          ],
        };
        opened.store.failNext(failpoint);
        const failed = await opened.root.commit(request);
        expect(failed).toMatchObject({ ok: false, error: { code: 'storage-failure' } });

        const afterFailure = await opened.root.readSnapshot();
        expect(afterFailure.ok).toBe(true);
        if (!afterFailure.ok) throw afterFailure.error;
        expect(afterFailure.value).toSatisfy(
          (snapshot) =>
            JSON.stringify(snapshot) === JSON.stringify(before.value) ||
            (snapshot.revision !== before.value.revision &&
              snapshot.active['assets/a.bin']?.[0] === 2 &&
              snapshot.active['assets/b.bin']?.[0] === 4),
        );

        const replay = await opened.root.commit(request);
        expect(replay.ok).toBe(true);
        if (!replay.ok) throw replay.error;
        const repeated = await opened.root.commit(request);
        expect(repeated).toEqual(replay);
      } finally {
        await rm(opened.directory, { recursive: true, force: true });
      }
    });
  }

  test('cleanup failure does not reverse a completed commit', async () => {
    const opened = await openRoot();
    try {
      const before = await seed(opened.root);
      expect(before.ok).toBe(true);
      if (!before.ok) throw before.error;
      opened.store.failNext('cleanup');
      const committed = await opened.root.commit({
        identity: 'cleanup-failure',
        expectedRevision: before.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/after.bin', bytes: Uint8Array.from([8]) }],
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw committed.error;
      const snapshot = await opened.root.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.active['assets/after.bin']).toEqual(Uint8Array.from([8]));
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });
});
