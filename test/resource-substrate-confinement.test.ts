import { describe, expect, test } from 'bun:test';
import { mkdtemp, readdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import type {
  ResourceObserverEvent,
  ResourceMutationIdentity,
  ResourceRoot,
  ResourceSnapshot,
} from '../src/resource-substrate/contract';

async function openRoot(
  directory: string,
  rootId = 'game-main',
  store = createFilesystemResourceStore({ directory }),
): Promise<{ root: ResourceRoot; store: ReturnType<typeof createFilesystemResourceStore> }> {
  const opened = await openResourceRoot({ rootId, store });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, store };
}

async function read(root: ResourceRoot): Promise<ResourceSnapshot> {
  const snapshot = await root.readSnapshot();
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw snapshot.error;
  return snapshot.value;
}

describe('filesystem root confinement', () => {
  test('rejects absolute, traversal, NUL, and reserved logical ids before writing bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-confinement-'));
    try {
      const opened = await openRoot(directory);
      const before = await read(opened.root);
      const invalidIds = ['/outside.bin', '../outside.bin', 'assets/\0bad.bin', '.forgeax/HEAD'];
      for (const resourceId of invalidIds) {
        const result = await opened.root.commit({
          identity: `invalid-${resourceId}`,
          expectedRevision: before.revision,
          changes: [{ kind: 'put', resourceId, bytes: Uint8Array.from([9]) }],
        });
        expect(result).toMatchObject({
          ok: false,
          error: {
            code: expect.stringMatching(/root-boundary-violation|invalid-resource-id/),
            hint: expect.any(String),
          },
        });
      }
      expect(await read(opened.root)).toEqual(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('rejects a symlinked state directory and control entry without changing the target root', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'resource-substrate-confinement-parent-'));
    const realDirectory = join(parent, 'real');
    const linkedDirectory = join(parent, 'linked');
    const outside = join(parent, 'outside');
    try {
      const initialized = await openRoot(realDirectory);
      const before = await read(initialized.root);
      await symlink(realDirectory, linkedDirectory);
      const linked = await openRoot(linkedDirectory);
      const rejectedDirectory = await linked.root.readSnapshot();
      expect(rejectedDirectory).toMatchObject({
        ok: false,
        error: { code: 'root-confinement-violation', hint: expect.any(String) },
      });
      expect(await read(initialized.root)).toEqual(before);

      await rm(linkedDirectory, { force: true });
      await writeFile(outside, 'tampered-head');
      const entries = await readdir(realDirectory, { recursive: true });
      const headEntry = entries.find((entry) => entry.endsWith('/HEAD'));
      expect(headEntry).toBeDefined();
      if (!headEntry) throw new Error('missing root HEAD');
      await unlink(join(realDirectory, headEntry));
      await symlink(outside, join(realDirectory, headEntry));
      const rejectedControl = await initialized.root.readSnapshot();
      expect(rejectedControl).toMatchObject({
        ok: false,
        error: { code: 'root-confinement-violation', hint: expect.any(String) },
      });
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });

  test('keeps resource facts isolated between two roots sharing one adapter', async () => {
    const parent = await mkdtemp(join(tmpdir(), 'resource-substrate-confinement-roots-'));
    try {
      const firstRootId = '\u00e9';
      const secondRootId = 'e\u0301';
      const store = createFilesystemResourceStore({ directory: parent });
      const first = await openRoot(parent, firstRootId, store);
      const second = await openRoot(parent, secondRootId, store);
      const firstEvents: ResourceObserverEvent[] = [];
      const secondEvents: ResourceObserverEvent[] = [];
      const firstBefore = await read(first.root);
      const secondBefore = await read(second.root);
      const firstObserver = await first.root.observe(
        { baselineRevision: firstBefore.revision },
        (event) => firstEvents.push(event),
      );
      const secondObserver = await second.root.observe(
        { baselineRevision: secondBefore.revision },
        (event) => secondEvents.push(event),
      );
      expect(firstObserver.ok).toBe(true);
      expect(secondObserver.ok).toBe(true);
      if (!firstObserver.ok) throw firstObserver.error;
      if (!secondObserver.ok) throw secondObserver.error;

      const seeded = await first.root.commit({
        identity: 'shared-identity',
        expectedRevision: firstBefore.revision,
        changes: [
          { kind: 'put', resourceId: 'assets/first.bin', bytes: Uint8Array.from([1]) },
          { kind: 'put', resourceId: 'assets/removed.bin', bytes: Uint8Array.from([2]) },
        ],
      });
      expect(seeded.ok).toBe(true);
      if (!seeded.ok) throw seeded.error;

      const committed = await first.root.commit({
        identity: 'first-trash',
        expectedRevision: seeded.value.afterRevision,
        changes: [{ kind: 'trash', resourceId: 'assets/removed.bin' }],
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw committed.error;

      const firstAfter = await read(first.root);
      const secondSnapshot = await read(second.root);
      expect(firstAfter.active['assets/first.bin']).toEqual(Uint8Array.from([1]));
      expect(firstAfter.trash).toMatchObject([
        { resourceId: 'assets/removed.bin', bytes: Uint8Array.from([2]) },
      ]);
      expect(secondSnapshot).toEqual(secondBefore);
      expect(await store.readMutation(secondRootId, 'shared-identity' as ResourceMutationIdentity)).toMatchObject({
        ok: true,
        value: null,
      });
      expect(await store.readRevision(secondRootId, committed.value.afterRevision)).toMatchObject({
        ok: true,
        value: null,
      });
      expect(secondEvents).toEqual([]);
      expect(firstEvents.filter((event) => event.kind === 'committed')).toHaveLength(2);

      const preparedRequest = {
        identity: 'prepared-first',
        expectedRevision: firstAfter.revision,
        changes: [{ kind: 'put' as const, resourceId: 'assets/prepared.bin', bytes: Uint8Array.from([4]) }],
      };
      store.failNext('prepared-fsync');
      const prepared = await first.root.commit(preparedRequest);
      expect(prepared).toMatchObject({ ok: false, error: { code: 'storage-failure' } });
      expect(await read(second.root)).toEqual(secondBefore);
      expect(await store.readMutation(secondRootId, 'prepared-first' as ResourceMutationIdentity)).toMatchObject({
        ok: true,
        value: null,
      });
      const rootEntries = (await readdir(join(parent, 'roots'))).filter((entry) => entry.startsWith('root-'));
      const preparedCounts = await Promise.all(
        rootEntries.map(async (entry) => {
          const entries = await readdir(join(parent, 'roots', entry), { recursive: true });
          return entries.filter((nested) => nested.startsWith('prepared/') && nested.endsWith('.json')).length;
        }),
      );
      expect(preparedCounts.sort()).toEqual([0, 1]);

      store.clearFaults();
      expect(await read(first.root)).toEqual(firstAfter);
      const recovered = await first.root.commit(preparedRequest);
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw recovered.error;
      const recoveredFirst = await read(first.root);
      expect(recoveredFirst.active['assets/prepared.bin']).toEqual(Uint8Array.from([4]));
      expect(await read(second.root)).toEqual(secondBefore);
      expect(await store.readMutation(secondRootId, 'prepared-first' as ResourceMutationIdentity)).toMatchObject({
        ok: true,
        value: null,
      });
      expect(await store.readRevision(secondRootId, recovered.value.afterRevision)).toMatchObject({
        ok: true,
        value: null,
      });
      expect(secondEvents).toEqual([]);
      expect(firstEvents.filter((event) => event.kind === 'committed')).toHaveLength(3);

      const secondCommitted = await second.root.commit({
        identity: 'shared-identity',
        expectedRevision: secondBefore.revision,
        changes: [{ kind: 'put', resourceId: 'assets/second.bin', bytes: Uint8Array.from([3]) }],
      });
      expect(secondCommitted.ok).toBe(true);
      if (!secondCommitted.ok) throw secondCommitted.error;

      const secondAfter = await read(second.root);
      expect(secondAfter.active).toEqual({ 'assets/second.bin': Uint8Array.from([3]) });
      expect(secondSnapshot.trash).toEqual([]);
      expect(secondEvents.filter((event) => event.kind === 'committed')).toMatchObject([
        { rootId: secondRootId, mutationIdentity: 'shared-identity' },
      ]);
      expect(firstEvents.filter((event) => event.kind === 'committed')).toHaveLength(3);

      await firstObserver.value.close();
      await secondObserver.value.close();
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  });
});
