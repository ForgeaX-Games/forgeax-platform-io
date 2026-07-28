import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as publicEntry from '@forgeax/platform-io';

type PublicStore = publicEntry.ResourceStore;
type PublicSnapshot = publicEntry.ResourceSnapshot;
type PublicMutationRecord = publicEntry.ResourceMutationRecord;

interface RootState {
  snapshot: PublicSnapshot;
  mutations: Map<string, PublicMutationRecord>;
}

function cloneSnapshot(snapshot: PublicSnapshot): PublicSnapshot {
  return {
    revision: snapshot.revision,
    active: Object.fromEntries(
      Object.entries(snapshot.active).map(([resourceId, bytes]) => [
        resourceId,
        new Uint8Array(bytes),
      ]),
    ),
    trash: snapshot.trash.map((entry) => ({
      ...entry,
      bytes: new Uint8Array(entry.bytes),
    })),
  };
}

function createConsumerStore(initial: PublicSnapshot): PublicStore {
  const state: RootState = {
    snapshot: cloneSnapshot(initial),
    mutations: new Map(),
  };

  return {
    async readSnapshot() {
      return { ok: true, value: cloneSnapshot(state.snapshot) };
    },
    async writeSnapshot(_rootId, snapshot) {
      state.snapshot = cloneSnapshot(snapshot);
      return { ok: true, value: undefined };
    },
    async readMutation(_rootId, identity) {
      const record = state.mutations.get(String(identity));
      return {
        ok: true,
        value: record ? { ...record, result: { ...record.result } } : null,
      };
    },
    async writeMutation(_rootId, record) {
      state.mutations.set(String(record.identity), {
        ...record,
        result: { ...record.result },
      });
      return { ok: true, value: undefined };
    },
    async commitMutation(_rootId, snapshot, record) {
      state.snapshot = cloneSnapshot(snapshot);
      state.mutations.set(String(record.identity), {
        ...record,
        result: { ...record.result },
      });
      return { ok: true, value: undefined };
    },
  };
}

interface ManualSource extends publicEntry.ResourceObserverSource {
  emit(event: publicEntry.ResourceObserverSourceEvent): Promise<void>;
}

function createManualSource(): ManualSource {
  let listener: publicEntry.ResourceObserverSourceCallback | undefined;
  return {
    subscribe(next) {
      listener = next;
      return { close: async () => undefined };
    },
    async emit(event) {
      await listener?.(event);
    },
  };
}

function bytes(value: number[]): Uint8Array {
  return Uint8Array.from(value);
}

describe('public resource substrate consumer contract', () => {
  test('opens, reopens, and recovers a durable store from the package entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-public-durable-'));
    try {
      const store = publicEntry.createFilesystemResourceStore({ directory });
      const opened = await publicEntry.openResourceRoot({ rootId: 'game-main', store });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw opened.error;

      const before = await opened.value.readSnapshot();
      expect(before.ok).toBe(true);
      if (!before.ok) throw before.error;
      const request = {
        identity: 'public-durable-recovery',
        expectedRevision: before.value.revision,
        changes: [{ kind: 'put' as const, resourceId: 'assets/recovered.bin', bytes: bytes([9, 8, 7]) }],
      };
      store.failNext('after-head-replace', 'public recovery smoke');
      const failed = await opened.value.commit(request);
      expect(failed).toMatchObject({
        ok: false,
        error: { code: 'storage-failure', retryable: true },
      });

      const reopenedStore = publicEntry.createFilesystemResourceStore({ directory });
      const reopened = await publicEntry.openResourceRoot({ rootId: 'game-main', store: reopenedStore });
      expect(reopened.ok).toBe(true);
      if (!reopened.ok) throw reopened.error;
      const recovered = await reopened.value.readSnapshot();
      expect(recovered.ok).toBe(true);
      if (!recovered.ok) throw recovered.error;
      expect(recovered.value.revision).not.toBe(before.value.revision);
      expect(recovered.value.active['assets/recovered.bin']).toEqual(bytes([9, 8, 7]));

      const replayed = await reopened.value.commit(request);
      expect(replayed).toMatchObject({
        ok: true,
        value: {
          identity: 'public-durable-recovery',
          beforeRevision: before.value.revision,
          afterRevision: recovered.value.revision,
          changed: true,
        },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('completes open, mutation, observation, recovery, and restore from the package entry', async () => {
    const source = createManualSource();
    const initialRevision = 'revision-0' as publicEntry.ResourceRevision;
    const store = createConsumerStore({
      revision: initialRevision,
      active: {
        'assets/move.bin': bytes([1, 2]),
        'assets/old.bin': bytes([7, 8, 9]),
      },
      trash: [],
    });
    const opened = await publicEntry.openResourceRoot({
      rootId: 'game-main',
      store,
      observerSource: source,
    });

    expect(opened.ok).toBe(true);
    if (!opened.ok) throw opened.error;
    expect(opened.value.descriptor).toEqual({
      rootId: 'game-main',
      capabilityVersion: 'resource-substrate.v1',
    });

    const before = await opened.value.readSnapshot();
    expect(before.ok).toBe(true);
    if (!before.ok) throw before.error;

    const events: publicEntry.ResourceObserverEvent[] = [];
    const observed = await opened.value.observe(
      { baselineRevision: before.value.revision },
      (event) => events.push(event),
    );
    expect(observed.ok).toBe(true);
    if (!observed.ok) throw observed.error;

    const committed = await opened.value.commit({
      identity: 'consumer-create-move-trash',
      expectedRevision: before.value.revision,
      changes: [
        { kind: 'put', resourceId: 'assets/new.bin', bytes: bytes([3, 4]) },
        { kind: 'move', from: 'assets/move.bin', to: 'assets/moved.bin' },
        { kind: 'trash', resourceId: 'assets/old.bin' },
      ],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw committed.error;
    expect(committed.value.changed).toBe(true);
    expect(committed.value.beforeRevision).toBe(before.value.revision);
    expect(committed.value.afterRevision).not.toBe(before.value.revision);

    const afterCommit = await opened.value.readSnapshot();
    expect(afterCommit.ok).toBe(true);
    if (!afterCommit.ok) throw afterCommit.error;
    expect(afterCommit.value.revision).toBe(committed.value.afterRevision);
    expect(afterCommit.value.active['assets/new.bin']).toEqual(bytes([3, 4]));
    expect(afterCommit.value.active['assets/moved.bin']).toEqual(bytes([1, 2]));
    expect(afterCommit.value.active['assets/move.bin']).toBeUndefined();
    expect(afterCommit.value.active['assets/old.bin']).toBeUndefined();
    expect(afterCommit.value.trash).toHaveLength(1);
    expect(afterCommit.value.trash[0]).toMatchObject({
      resourceId: 'assets/old.bin',
      mutationIdentity: 'consumer-create-move-trash',
      revision: committed.value.afterRevision,
    });
    expect(afterCommit.value.trash[0]?.bytes).toEqual(bytes([7, 8, 9]));
    const committedEvent = events.find((event) => event.kind === 'committed');
    expect(committedEvent).toMatchObject({
      kind: 'committed',
      rootId: 'game-main',
      mutationIdentity: 'consumer-create-move-trash',
      beforeRevision: before.value.revision,
      afterRevision: committed.value.afterRevision,
      resourceIds: ['assets/new.bin', 'assets/move.bin', 'assets/moved.bin', 'assets/old.bin'],
    });

    await source.emit({ kind: 'change' });
    expect(events.at(-1)).toMatchObject({
      kind: 'invalidation',
      code: 'observer-invalidation',
      rootId: 'game-main',
      currentRevision: committed.value.afterRevision,
      hint: expect.any(String),
    });

    const stale = await opened.value.commit({
      identity: 'consumer-stale-request',
      expectedRevision: before.value.revision,
      changes: [{ kind: 'put', resourceId: 'assets/stale.bin', bytes: bytes([5]) }],
    });
    expect(stale).toMatchObject({
      ok: false,
      error: {
        code: 'stale-revision',
        expected: before.value.revision,
        actual: committed.value.afterRevision,
        hint: expect.any(String),
        retryable: true,
      },
    });
    if (stale.ok) throw new Error('Expected the stale request to be rejected.');
    expect(stale.error.message).toContain('stale-revision');

    await source.emit({ kind: 'error', reason: 'source unavailable' });
    expect(events.at(-1)).toMatchObject({
      kind: 'error',
      currentRevision: committed.value.afterRevision,
      error: {
        code: 'observer-error',
        storageReason: 'source unavailable',
        hint: expect.any(String),
        retryable: true,
      },
    });

    const restored = await opened.value.commit({
      identity: 'consumer-restore-trash',
      expectedRevision: committed.value.afterRevision,
      changes: [
        {
          kind: 'restore',
          resourceId: 'assets/old.bin',
          targetResourceId: 'assets/restored.bin',
        },
      ],
    });
    expect(restored.ok).toBe(true);
    if (!restored.ok) throw restored.error;
    expect(restored.value.beforeRevision).toBe(committed.value.afterRevision);
    expect(restored.value.afterRevision).not.toBe(restored.value.beforeRevision);

    const finalSnapshot = await opened.value.readSnapshot();
    expect(finalSnapshot.ok).toBe(true);
    if (!finalSnapshot.ok) throw finalSnapshot.error;
    expect(finalSnapshot.value.active['assets/restored.bin']).toEqual(bytes([7, 8, 9]));
    expect(finalSnapshot.value.trash).toHaveLength(0);
    const listedTrash = await opened.value.listTrash();
    expect(listedTrash).toEqual({ ok: true, value: [] });

    await observed.value.close();
    await observed.value.closed;
  });
});
