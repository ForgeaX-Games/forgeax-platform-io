import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import type {
  ResourceObserverEvent,
  ResourceObserverSource,
  ResourceObserverSourceEvent,
  ResourceRoot,
} from '../src/resource-substrate/contract';

interface ManualSource extends ResourceObserverSource {
  emit(event: ResourceObserverSourceEvent): Promise<void>;
}

function createManualSource(): ManualSource {
  let listener: ((event: ResourceObserverSourceEvent) => void | Promise<void>) | undefined;
  let closed = false;
  return {
    subscribe(next) {
      listener = next;
      return {
        async close() {
          closed = true;
          listener = undefined;
        },
      };
    },
    async emit(event) {
      if (!closed) await listener?.(event);
    },
  };
}

async function openRoot(source: ResourceObserverSource): Promise<{
  root: ResourceRoot;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-observer-source-'));
  const opened = await openResourceRoot({
    rootId: 'game-main',
    store: createFilesystemResourceStore({ directory }),
    observerSource: source,
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, directory };
}

describe('resource observer external source', () => {
  test('maps source changes to invalidation and exposes a resync revision', async () => {
    const source = createManualSource();
    const opened = await openRoot(source);
    try {
      const before = await opened.root.readSnapshot();
      expect(before.ok).toBe(true);
      if (!before.ok) throw before.error;
      const committed = await opened.root.commit({
        identity: 'observer-source-seed',
        expectedRevision: before.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/source.bin', bytes: Uint8Array.from([1]) }],
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw committed.error;

      let resyncedRevision = '';
      const events: ResourceObserverEvent[] = [];
      const observed = await opened.root.observe(
        { baselineRevision: committed.value.afterRevision },
        async (event) => {
          events.push(event);
          if (event.kind === 'invalidation') {
            const snapshot = await opened.root.readSnapshot();
            expect(snapshot.ok).toBe(true);
            if (snapshot.ok) resyncedRevision = snapshot.value.revision;
          }
        },
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      await source.emit({ kind: 'change' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'invalidation',
        code: 'observer-invalidation',
        rootId: 'game-main',
        currentRevision: committed.value.afterRevision,
        hint: expect.any(String),
      });
      expect(resyncedRevision).toBe(committed.value.afterRevision);
      expect('mutationIdentity' in events[0]).toBe(false);
      await observed.value.close();
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  test('maps source overflow to a gap without fabricating a committed mutation', async () => {
    const source = createManualSource();
    const opened = await openRoot(source);
    try {
      const baseline = await opened.root.readSnapshot();
      expect(baseline.ok).toBe(true);
      if (!baseline.ok) throw baseline.error;
      const committed = await opened.root.commit({
        identity: 'observer-source-overflow-seed',
        expectedRevision: baseline.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/overflow.bin', bytes: Uint8Array.from([2]) }],
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw committed.error;

      const events: ResourceObserverEvent[] = [];
      const observed = await opened.root.observe(
        { baselineRevision: baseline.value.revision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;
      events.length = 0;

      await source.emit({ kind: 'overflow' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'gap',
        code: 'observer-gap',
        rootId: 'game-main',
        baselineRevision: baseline.value.revision,
        currentRevision: committed.value.afterRevision,
        hint: expect.any(String),
      });
      expect('mutationIdentity' in events[0]).toBe(false);
      await observed.value.close();
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  test('maps source failures to structured errors with current revision facts', async () => {
    const source = createManualSource();
    const opened = await openRoot(source);
    try {
      const current = await opened.root.readSnapshot();
      expect(current.ok).toBe(true);
      if (!current.ok) throw current.error;
      const events: ResourceObserverEvent[] = [];
      const observed = await opened.root.observe(
        { baselineRevision: current.value.revision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      await source.emit({ kind: 'error', reason: 'source unavailable' });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: 'error',
        rootId: 'game-main',
        currentRevision: current.value.revision,
        error: {
          code: 'observer-error',
          hint: expect.any(String),
          retryable: true,
          storageReason: 'source unavailable',
        },
      });
      expect('mutationIdentity' in events[0]).toBe(false);
      await observed.value.close();
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });
});
