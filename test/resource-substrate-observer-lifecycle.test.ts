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
  const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-observer-lifecycle-'));
  const opened = await openResourceRoot({
    rootId: 'game-main',
    store: createFilesystemResourceStore({ directory }),
    observerSource: source,
  });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, directory };
}

describe('resource observer lifecycle', () => {
  test('close is idempotent, awaitable, and prevents later deliveries', async () => {
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

      const firstClose = observed.value.close();
      const secondClose = observed.value.close();
      await Promise.all([firstClose, secondClose]);
      await observed.value.closed;
      const countAfterClose = events.length;
      await source.emit({ kind: 'change' });
      expect(events).toHaveLength(countAfterClose);
      await observed.value.close();
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  test('isolates callback errors as structured observer errors', async () => {
    const source = createManualSource();
    const opened = await openRoot(source);
    try {
      const current = await opened.root.readSnapshot();
      expect(current.ok).toBe(true);
      if (!current.ok) throw current.error;
      const events: ResourceObserverEvent[] = [];
      let threw = false;
      const observed = await opened.root.observe(
        { baselineRevision: current.value.revision },
        (event) => {
          events.push(event);
          if (!threw && event.kind === 'invalidation') {
            threw = true;
            throw new Error('callback failed');
          }
        },
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      await source.emit({ kind: 'change' });
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({
        kind: 'error',
        rootId: 'game-main',
        error: {
          code: 'observer-error',
          hint: expect.any(String),
          retryable: true,
          storageReason: 'callback failed',
        },
      });
      await observed.value.close();
      await observed.value.closed;
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  test('close wins a source and callback race without post-close events', async () => {
    const source = createManualSource();
    const opened = await openRoot(source);
    try {
      const current = await opened.root.readSnapshot();
      expect(current.ok).toBe(true);
      if (!current.ok) throw current.error;
      const events: ResourceObserverEvent[] = [];
      const observed = await opened.root.observe(
        { baselineRevision: current.value.revision },
        async (event) => {
          events.push(event);
          await Promise.resolve();
        },
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      await Promise.all([source.emit({ kind: 'change' }), observed.value.close()]);
      await observed.value.closed;
      const countAfterClose = events.length;
      await source.emit({ kind: 'overflow' });
      expect(events).toHaveLength(countAfterClose);
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });
});
