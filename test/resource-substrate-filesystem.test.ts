import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import type { ResourceRoot, ResourceRevision } from '../src/resource-substrate/contract';

async function openFilesystemRoot(): Promise<{
  root: ResourceRoot;
  directory: string;
  store: ReturnType<typeof createFilesystemResourceStore>;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-filesystem-'));
  const store = createFilesystemResourceStore({ directory });
  const opened = await openResourceRoot({ rootId: 'game-main', store });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, directory, store };
}

async function cleanup(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

describe('filesystem resource snapshot store', () => {
  test('initializes durable state and binds active/trash reads to one HEAD revision', async () => {
    const opened = await openFilesystemRoot();
    try {
      const initial = await opened.root.readSnapshot();
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw initial.error;

      const committed = await opened.root.commit({
        identity: 'filesystem-seed',
        expectedRevision: initial.value.revision,
        changes: [
          { kind: 'put', resourceId: 'assets/current.bin', bytes: Uint8Array.from([1, 2]) },
          { kind: 'put', resourceId: 'assets/old.bin', bytes: Uint8Array.from([3, 4]) },
        ],
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw committed.error;

      const trashed = await opened.root.commit({
        identity: 'filesystem-trash',
        expectedRevision: committed.value.afterRevision,
        changes: [{ kind: 'trash', resourceId: 'assets/old.bin' }],
      });
      expect(trashed.ok).toBe(true);
      if (!trashed.ok) throw trashed.error;

      const snapshot = await opened.root.readSnapshot();
      expect(snapshot.ok).toBe(true);
      if (!snapshot.ok) throw snapshot.error;
      expect(snapshot.value.revision).toBe(trashed.value.afterRevision);
      expect(snapshot.value.active).toEqual({ 'assets/current.bin': Uint8Array.from([1, 2]) });
      expect(snapshot.value.trash).toMatchObject([
        { resourceId: 'assets/old.bin', bytes: Uint8Array.from([3, 4]) },
      ]);

      const stateEntries = await readdir(opened.store.stateDirectory, { recursive: true });
      expect(stateEntries.some((entry) => entry.endsWith('/HEAD'))).toBe(true);
      expect(stateEntries.some((entry) => entry.includes('/blobs/'))).toBe(true);
      expect(stateEntries.some((entry) => entry.includes('/revisions/'))).toBe(true);
    } finally {
      await cleanup(opened.directory);
    }
  });

  test('retains old revisions and restores content-addressed bytes', async () => {
    const opened = await openFilesystemRoot();
    try {
      const initial = await opened.root.readSnapshot();
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw initial.error;

      const first = await opened.root.commit({
        identity: 'revision-one',
        expectedRevision: initial.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/item.bin', bytes: Uint8Array.from([9, 8, 7]) }],
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw first.error;

      const second = await opened.root.commit({
        identity: 'revision-two',
        expectedRevision: first.value.afterRevision,
        changes: [{ kind: 'put', resourceId: 'assets/item.bin', bytes: Uint8Array.from([6, 5, 4]) }],
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw second.error;

      const old = await opened.store.readSnapshotAt('game-main', first.value.afterRevision);
      expect(old.ok).toBe(true);
      if (!old.ok) throw old.error;
      expect(old.value.revision).toBe(first.value.afterRevision as ResourceRevision);
      expect(old.value.active['assets/item.bin']).toEqual(Uint8Array.from([9, 8, 7]));
      expect(old.value.active['assets/item.bin']).not.toEqual(
        Uint8Array.from([6, 5, 4]),
      );
    } finally {
      await cleanup(opened.directory);
    }
  });
});
