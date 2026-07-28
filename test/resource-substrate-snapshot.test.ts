import { describe, expect, test } from 'bun:test';
import { openResourceRoot } from '../src/resource-substrate';
import type { ResourceRoot, ResourceSnapshot } from '../src/resource-substrate/contract';
import { createMemoryResourceStore } from './support/resource-substrate-store';

async function openRoot(): Promise<ResourceRoot> {
  const opened = await openResourceRoot({
    rootId: 'game-main',
    store: createMemoryResourceStore(),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return opened.value;
}

async function read(root: ResourceRoot): Promise<ResourceSnapshot> {
  const snapshot = await root.readSnapshot();
  expect(snapshot.ok).toBe(true);
  if (!snapshot.ok) throw snapshot.error;
  return snapshot.value;
}

describe('revision-bound resource snapshots', () => {
  test('reads active and trash from one complete revision', async () => {
    const root = await openRoot();
    const initial = await read(root);
    const seeded = await root.commit({
      identity: 'seed',
      expectedRevision: initial.revision,
      changes: [
        { kind: 'put', resourceId: 'assets/new.bin', bytes: Uint8Array.from([1]) },
        { kind: 'put', resourceId: 'assets/old.bin', bytes: Uint8Array.from([2]) },
      ],
    });
    expect(seeded.ok).toBe(true);
    if (!seeded.ok) throw seeded.error;

    const trashed = await root.commit({
      identity: 'trash',
      expectedRevision: seeded.value.afterRevision,
      changes: [{ kind: 'trash', resourceId: 'assets/old.bin' }],
    });
    expect(trashed.ok).toBe(true);
    if (!trashed.ok) throw trashed.error;

    const snapshot = await read(root);
    expect(snapshot.revision).toBe(trashed.value.afterRevision);
    expect(snapshot.active).toEqual({ 'assets/new.bin': Uint8Array.from([1]) });
    expect(snapshot.trash).toHaveLength(1);
    expect(snapshot.trash[0]?.revision).toBe(snapshot.revision);
    expect(snapshot.trash[0]?.bytes).toEqual(Uint8Array.from([2]));
  });

  test('keeps old and new reads bound to complete revisions', async () => {
    const root = await openRoot();
    const oldState = await read(root);
    const committed = await root.commit({
      identity: 'new',
      expectedRevision: oldState.revision,
      changes: [{ kind: 'put', resourceId: 'assets/new.bin', bytes: Uint8Array.from([3]) }],
    });
    expect(committed.ok).toBe(true);
    if (!committed.ok) throw committed.error;

    const newState = await read(root);
    expect(oldState).toMatchObject({ revision: oldState.revision, active: {} });
    expect(newState).toMatchObject({ revision: committed.value.afterRevision });
    expect(newState.active['assets/new.bin']).toEqual(Uint8Array.from([3]));
    expect(oldState.active['assets/new.bin']).toBeUndefined();
  });

  test('keeps one revision for a semantic no-op snapshot', async () => {
    const root = await openRoot();
    const initial = await read(root);
    const noOp = await root.commit({
      identity: 'empty',
      expectedRevision: initial.revision,
      changes: [],
    });
    expect(noOp).toMatchObject({
      ok: true,
      value: {
        beforeRevision: initial.revision,
        afterRevision: initial.revision,
        changed: false,
      },
    });

    const snapshot = await read(root);
    expect(snapshot.revision).toBe(initial.revision);
    expect(snapshot.active).toEqual({});
    expect(snapshot.trash).toEqual([]);
  });
});
