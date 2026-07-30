import { describe, expect, test } from 'bun:test';
import type {
  ResourceMutation,
  ResourceRevision,
  ResourceSnapshot,
} from '../src/resource-substrate/contract';
import {
  createInitialManifest,
  reduceResourceMutation,
} from '../src/resource-substrate/manifest';

const revision = (value: string) => value as ResourceRevision;

function mutation(
  changes: ResourceMutation['changes'],
  identity = 'mutation-1',
  expectedRevision = revision('revision-0'),
): ResourceMutation {
  return {
    identity,
    expectedRevision,
    changes,
  };
}

function bytes(...values: number[]): Uint8Array {
  return Uint8Array.from(values);
}

function apply(snapshot: ResourceSnapshot, request: ResourceMutation) {
  const result = reduceResourceMutation(snapshot, request);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('resource manifest mutation reducer', () => {
  test('creates and replaces opaque resource bytes without mutating the input', () => {
    const original = createInitialManifest(revision('revision-0'));
    const originalCopy = structuredClone(original);

    const created = apply(
      original,
      mutation([{ kind: 'put', resourceId: 'scenes/main.pack', bytes: bytes(1, 2) }]),
    );
    expect(created.snapshot.active['scenes/main.pack']).toEqual(bytes(1, 2));
    expect(created.result.changed).toBe(true);
    expect(created.snapshot.revision).not.toBe(original.revision);
    expect(original).toEqual(originalCopy);

    const replaced = apply(
      created.snapshot,
      mutation(
        [{ kind: 'put', resourceId: 'scenes/main.pack', bytes: bytes(3, 4) }],
        'mutation-2',
        created.snapshot.revision,
      ),
    );
    expect(replaced.snapshot.active['scenes/main.pack']).toEqual(bytes(3, 4));
    expect(replaced.snapshot.revision).not.toBe(created.snapshot.revision);
  });

  test('moves an active resource and rejects an occupied target', () => {
    const seeded = apply(
      createInitialManifest(revision('revision-0')),
      mutation([
        { kind: 'put', resourceId: 'assets/source.bin', bytes: bytes(7) },
        { kind: 'put', resourceId: 'assets/occupied.bin', bytes: bytes(8) },
      ]),
    ).snapshot;

    const moved = apply(
      seeded,
      mutation(
        [{ kind: 'move', from: 'assets/source.bin', to: 'assets/moved.bin' }],
        'mutation-1',
        seeded.revision,
      ),
    );
    expect(moved.snapshot.active['assets/source.bin']).toBeUndefined();
    expect(moved.snapshot.active['assets/moved.bin']).toEqual(bytes(7));

    const beforeRejected = structuredClone(moved.snapshot);
    const rejected = reduceResourceMutation(
      moved.snapshot,
      mutation(
        [{ kind: 'move', from: 'assets/moved.bin', to: 'assets/occupied.bin' }],
        'mutation-3',
        moved.snapshot.revision,
      ),
    );
    expect(rejected).toMatchObject({ ok: false, error: { code: 'resource-conflict' } });
    expect(moved.snapshot).toEqual(beforeRejected);
  });

  test('rejects duplicate resource participation before writing any change', () => {
    const original = createInitialManifest(revision('revision-0'));
    const rejected = reduceResourceMutation(
      original,
      mutation([
        { kind: 'put', resourceId: 'assets/item.bin', bytes: bytes(1) },
        { kind: 'put', resourceId: 'assets/item.bin', bytes: bytes(2) },
      ]),
    );

    expect(rejected).toMatchObject({ ok: false, error: { code: 'resource-conflict' } });
    expect(original).toEqual(createInitialManifest(revision('revision-0')));
  });

  test('returns a no-op for an empty mutation and preserves the revision', () => {
    const original = createInitialManifest(revision('revision-0'));
    const result = apply(original, mutation([]));

    expect(result.result.changed).toBe(false);
    expect(result.snapshot.revision).toBe(original.revision);
    expect(result.snapshot.active).toEqual({});
  });

  test('produces deterministic output for the same ordered input', () => {
    const original = createInitialManifest(revision('revision-0'));
    const request = mutation([
      { kind: 'put', resourceId: 'b/item.bin', bytes: bytes(2) },
      { kind: 'put', resourceId: 'a/item.bin', bytes: bytes(1) },
    ]);

    const first = apply(original, request);
    const second = apply(original, structuredClone(request));

    expect(first).toEqual(second);
    expect(first.requestDigest).toBe(second.requestDigest);
  });

  test('trash and restore preserve opaque bytes and revision boundaries', () => {
    const seeded = apply(
      createInitialManifest(revision('revision-0')),
      mutation([{ kind: 'put', resourceId: 'assets/item.bin', bytes: bytes(4, 5) }]),
    );
    const trashed = apply(
      seeded.snapshot,
      mutation(
        [{ kind: 'trash', resourceId: 'assets/item.bin' }],
        'mutation-trash',
        seeded.snapshot.revision,
      ),
    );
    expect(trashed.snapshot.active['assets/item.bin']).toBeUndefined();
    expect(trashed.snapshot.trash[0]?.bytes).toEqual(bytes(4, 5));

    const restored = apply(
      trashed.snapshot,
      mutation(
        [{ kind: 'restore', resourceId: 'assets/item.bin' }],
        'mutation-restore',
        trashed.snapshot.revision,
      ),
    );
    expect(restored.snapshot.active['assets/item.bin']).toEqual(bytes(4, 5));
    expect(restored.snapshot.trash).toEqual([]);
    expect(restored.snapshot.revision).not.toBe(trashed.snapshot.revision);
  });
});
