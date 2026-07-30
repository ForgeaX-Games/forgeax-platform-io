import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import type { ResourceRoot } from '../src/resource-substrate/contract';
import type { FilesystemStoreFailpoint } from '../src/resource-substrate/storage';

const crashPoints: readonly FilesystemStoreFailpoint[] = [
  'blob-write',
  'blob-fsync',
  'manifest-write',
  'manifest-fsync',
  'prepared-write',
  'prepared-fsync',
  'head-replace',
  'after-head-replace',
  'head-fsync',
  'terminal-write',
  'terminal-fsync',
];

async function openRoot(directory: string): Promise<ResourceRoot> {
  const store = createFilesystemResourceStore({ directory });
  const opened = await openResourceRoot({ rootId: 'game-main', store });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return opened.value;
}

async function seed(root: ResourceRoot) {
  const initial = await root.readSnapshot();
  expect(initial.ok).toBe(true);
  if (!initial.ok) throw initial.error;
  const result = await root.commit({
    identity: 'recovery-seed',
    expectedRevision: initial.value.revision,
    changes: [{ kind: 'put', resourceId: 'assets/base.bin', bytes: Uint8Array.from([1, 2, 3]) }],
  });
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return root.readSnapshot();
}

describe('filesystem startup recovery', () => {
  for (const failpoint of crashPoints) {
    test(`recovers a complete state after child exit at ${failpoint}`, async () => {
      const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-'));
      try {
        const parent = await openRoot(directory);
        const before = await seed(parent);
        expect(before.ok).toBe(true);
        if (!before.ok) throw before.error;

        const worker = Bun.spawn([
          'bun',
          'run',
          'test/fixtures/resource-substrate-crash-worker.ts',
          directory,
          failpoint,
        ]);
        const exitCode = await worker.exited;
        expect(exitCode).toBe(77);

        const recoveredStore = createFilesystemResourceStore({ directory });
        const recovered = await openResourceRoot({ rootId: 'game-main', store: recoveredStore });
        expect(recovered.ok).toBe(true);
        if (!recovered.ok) throw recovered.error;
        const snapshot = await recovered.value.readSnapshot();
        expect(snapshot.ok).toBe(true);
        if (!snapshot.ok) throw snapshot.error;
        const hasBefore =
          snapshot.value.active['assets/crash-a.bin'] === undefined &&
          snapshot.value.active['assets/crash-b.bin'] === undefined;
        const hasAfter =
          snapshot.value.active['assets/crash-a.bin']?.[0] === 6 &&
          snapshot.value.active['assets/crash-b.bin']?.[0] === 8;
        expect(hasBefore !== hasAfter).toBe(true);

        const replay = await recovered.value.commit({
          identity: `crash-${failpoint}`,
          expectedRevision: before.value.revision,
          changes: [
            { kind: 'put', resourceId: 'assets/crash-a.bin', bytes: Uint8Array.from([6, 7]) },
            { kind: 'put', resourceId: 'assets/crash-b.bin', bytes: Uint8Array.from([8, 9]) },
          ],
        });
        expect(replay.ok).toBe(true);
        if (!replay.ok) throw replay.error;
        const repeated = await recovered.value.commit({
          identity: `crash-${failpoint}`,
          expectedRevision: before.value.revision,
          changes: [
            { kind: 'put', resourceId: 'assets/crash-a.bin', bytes: Uint8Array.from([6, 7]) },
            { kind: 'put', resourceId: 'assets/crash-b.bin', bytes: Uint8Array.from([8, 9]) },
          ],
        });
        expect(repeated).toEqual(replay);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    });
  }

  test('recovery keeps a cross-resource mutation at one complete revision', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-cross-resource-'));
    try {
      const root = await openRoot(directory);
      const before = await root.readSnapshot();
      expect(before.ok).toBe(true);
      if (!before.ok) throw before.error;
      const store = createFilesystemResourceStore({ directory });
      store.failNext('terminal-write', 'terminal record interrupted');
      const failingRoot = await openResourceRoot({ rootId: 'game-main', store });
      expect(failingRoot.ok).toBe(true);
      if (!failingRoot.ok) throw failingRoot.error;
      const failed = await failingRoot.value.commit({
        identity: 'cross-resource-failure',
        expectedRevision: before.value.revision,
        changes: [
          { kind: 'put', resourceId: 'assets/a.bin', bytes: Uint8Array.from([1]) },
          { kind: 'put', resourceId: 'assets/b.bin', bytes: Uint8Array.from([2]) },
        ],
      });
      expect(failed.ok).toBe(false);

      const recovered = await openRoot(directory);
      const snapshot = await recovered.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw snapshot.error;
      const complete = snapshot.value.active['assets/a.bin'] !== undefined && snapshot.value.active['assets/b.bin'] !== undefined;
      const empty = snapshot.value.active['assets/a.bin'] === undefined && snapshot.value.active['assets/b.bin'] === undefined;
      expect(complete || empty).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
