import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as publicEntry from '@forgeax/platform-io';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import type {
  ResourceObserverEvent,
  ResourceObserverSource,
  ResourceObserverSourceEvent,
  ResourceMutationIdentity,
  ResourceId,
} from '../src/resource-substrate/contract';

interface ManualSource extends ResourceObserverSource {
  emit(event: ResourceObserverSourceEvent): Promise<void>;
}

function createManualSource(): ManualSource {
  let listener: ((event: ResourceObserverSourceEvent) => void | Promise<void>) | undefined;
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

describe('resource observer public contract', () => {
  test('declares an available observer capability with a versioned event vocabulary', () => {
    const index = publicEntry.RESOURCE_SUBSTRATE_CAPABILITY_INDEX;
    const observer = index.descriptors.find((descriptor) => descriptor.name === 'observer');
    expect(observer).toMatchObject({
      name: 'observer',
      version: 'resource-substrate.v1',
      status: 'available',
    });
    expect(index.publicTypes).toContain('ResourceObserverEvent');
  });

  test('keeps committed events complete and tied to the public revision chain', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-observer-contract-'));
    try {
      const store = createFilesystemResourceStore({ directory });
      const opened = await publicEntry.openResourceRoot({ rootId: 'game-main', store });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw opened.error;
      const before = await opened.value.readSnapshot();
      expect(before.ok).toBe(true);
      if (!before.ok) throw before.error;
      const committed = await opened.value.commit({
        identity: 'observer-contract-commit',
        expectedRevision: before.value.revision,
        changes: [{ kind: 'put', resourceId: 'assets/contract.bin', bytes: Uint8Array.from([3]) }],
      });
      expect(committed.ok).toBe(true);
      if (!committed.ok) throw committed.error;

      const events: ResourceObserverEvent[] = [];
      const observed = await opened.value.observe(
        { baselineRevision: before.value.revision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;
      expect(events).toHaveLength(1);
      expect(events[0]).toEqual({
        kind: 'committed',
        rootId: 'game-main',
        mutationIdentity: 'observer-contract-commit' as ResourceMutationIdentity,
        beforeRevision: before.value.revision,
        afterRevision: committed.value.afterRevision,
        resourceIds: ['assets/contract.bin' as ResourceId],
      });
      await observed.value.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keeps non-committed events machine-readable and free of mutation identity', async () => {
    const source = createManualSource();
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-observer-contract-source-'));
    try {
      const store = createFilesystemResourceStore({ directory });
      const opened = await publicEntry.openResourceRoot({
        rootId: 'game-main',
        store,
        observerSource: source,
      });
      expect(opened.ok).toBe(true);
      if (!opened.ok) throw opened.error;
      const current = await opened.value.readSnapshot();
      expect(current.ok).toBe(true);
      if (!current.ok) throw current.error;
      const events: ResourceObserverEvent[] = [];
      const observed = await opened.value.observe(
        { baselineRevision: current.value.revision },
        (event) => events.push(event),
      );
      expect(observed.ok).toBe(true);
      if (!observed.ok) throw observed.error;

      await source.emit({ kind: 'change' });
      await source.emit({ kind: 'overflow' });
      await source.emit({ kind: 'error', reason: 'contract source failure' });
      expect(events).toHaveLength(3);
      expect(events[0]).toMatchObject({
        kind: 'invalidation',
        code: 'observer-invalidation',
        rootId: 'game-main',
        currentRevision: current.value.revision,
        hint: expect.any(String),
      });
      expect(events[1]).toMatchObject({
        kind: 'gap',
        code: 'observer-gap',
        rootId: 'game-main',
        baselineRevision: current.value.revision,
        currentRevision: current.value.revision,
        hint: expect.any(String),
      });
      expect(events[2]).toMatchObject({
        kind: 'error',
        rootId: 'game-main',
        currentRevision: current.value.revision,
        error: {
          code: 'observer-error',
          hint: expect.any(String),
          retryable: true,
          storageReason: 'contract source failure',
        },
      });
      for (const event of events) {
        expect('mutationIdentity' in event).toBe(false);
        expect(typeof event.rootId).toBe('string');
      }
      await observed.value.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
