import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import type {
  ResourceObserverEvent,
  ResourceRevision,
  ResourceRoot,
} from '../src/resource-substrate/contract';

async function openRoot(): Promise<{ root: ResourceRoot; directory: string }> {
  const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-observer-replay-'));
  const opened = await openResourceRoot({
    rootId: 'game-main',
    store: createFilesystemResourceStore({ directory }),
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, directory };
}

function committedEvents(events: readonly ResourceObserverEvent[]) {
  return events.filter((event) => event.kind === 'committed');
}

describe('resource observer committed replay', () => {
  test('replays each committed mutation from a known baseline revision', async () => {
    const opened = await openRoot();
    try {
      const baseline = await opened.root.readSnapshot();
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) throw baseline.error;

      const first = await opened.root.commit({
        identity: 'observer-replay-one',
        expectedRevision: baseline.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/one.bin', bytes: Uint8Array.from([1]) }],
      });
      expect(first.ok).toBe(true);
      if (!first.ok) throw first.error;

      const second = await opened.root.commit({
        identity: 'observer-replay-two',
        expectedRevision: first.value.afterRevision,
        changes: [{ kind: 'put', resourceId: 'assets/two.bin', bytes: Uint8Array.from([2]) }],
      });
      expect(second.ok).toBe(true);
      if (!second.ok) throw second.error;

      const events: ResourceObserverEvent[] = [];
      const observed = await opened.root.observe(
        { baselineRevision: baseline.value.revision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      const committed = committedEvents(events);
      expect(committed).toHaveLength(2);
      expect(committed[0]).toMatchObject({
        kind: 'committed',
        rootId: 'game-main',
        mutationIdentity: 'observer-replay-one',
        beforeRevision: baseline.value.revision,
        afterRevision: first.value.afterRevision,
        resourceIds: ['assets/one.bin'],
      });
      expect(committed[1]).toMatchObject({
        kind: 'committed',
        mutationIdentity: 'observer-replay-two',
        beforeRevision: first.value.afterRevision,
        afterRevision: second.value.afterRevision,
        resourceIds: ['assets/two.bin'],
      });
      await observed.value.close();
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  test('does not report a failed mutation as committed', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-observer-failure-'));
    try {
      const store = createFilesystemResourceStore({ directory });
      const opened = await openResourceRoot({ rootId: 'game-main', store });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw opened.error;
      const baseline = await opened.value.readSnapshot();
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) throw baseline.error;

      const seed = await opened.value.commit({
        identity: 'observer-replay-seed',
        expectedRevision: baseline.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/seed.bin', bytes: Uint8Array.from([1]) }],
      });
      expect(seed.ok).toBe(true);
      if (!seed.ok) throw seed.error;

      const events: ResourceObserverEvent[] = [];
      const observed = await opened.value.observe(
        { baselineRevision: baseline.value.revision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      store.failNext('manifest-write');
      const failed = await opened.value.commit({
        identity: 'observer-replay-failed',
        expectedRevision: seed.value.afterRevision,
        changes: [{ kind: 'put', resourceId: 'assets/failed.bin', bytes: Uint8Array.from([9]) }],
      });
      expect(failed).toMatchObject({ ok: false, error: { code: 'storage-failure' } });
      expect(committedEvents(events)).toHaveLength(1);
      expect(committedEvents(events)[0]).toMatchObject({
        mutationIdentity: 'observer-replay-seed',
        afterRevision: seed.value.afterRevision,
      });
      expect(events.some((event) => event.kind === 'committed' && event.mutationIdentity === 'observer-replay-failed')).toBe(false);
      await observed.value.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('reports an unknown baseline as a resynchronization gap', async () => {
    const opened = await openRoot();
    try {
      const current = await opened.root.readSnapshot();
      expect(current.ok).toBe(true);
      if (!current.ok) throw current.error;

      const events: ResourceObserverEvent[] = [];
      const observed = await opened.root.observe(
        { baselineRevision: 'revision-does-not-exist' as ResourceRevision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'gap',
        rootId: 'game-main',
        baselineRevision: 'revision-does-not-exist',
        currentRevision: current.value.revision,
        hint: expect.any(String),
      });
      await observed.value.close();
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });
});
