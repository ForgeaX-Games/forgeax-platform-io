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

function request(
  changes: ResourceMutation['changes'],
  identity: string,
  expectedRevision: ResourceRevision,
): ResourceMutation {
  return { identity, expectedRevision, changes };
}

function apply(snapshot: ResourceSnapshot, mutation: ResourceMutation) {
  const result = reduceResourceMutation(snapshot, mutation);
  expect(result.ok).toBe(true);
  if (!result.ok) throw result.error;
  return result.value;
}

describe('resource manifest trash and restore', () => {
  test('moves bytes atomically from active to trash and restores them byte-for-byte', () => {
    const initial = createInitialManifest(revision('revision-0'));
    const seeded = apply(
      initial,
      request(
        [{ kind: 'put', resourceId: 'assets/old.bin', bytes: Uint8Array.from([0, 255, 3]) }],
        'put-old',
        initial.revision,
      ),
    );
    const trashed = apply(
      seeded.snapshot,
      request([{ kind: 'trash', resourceId: 'assets/old.bin' }], 'trash-old', seeded.snapshot.revision),
    );

    expect(trashed.snapshot.active['assets/old.bin']).toBeUndefined();
    expect(trashed.snapshot.trash).toHaveLength(1);
    expect(trashed.snapshot.trash[0]).toMatchObject({
      resourceId: 'assets/old.bin',
      mutationIdentity: 'trash-old',
      revision: trashed.snapshot.revision,
    });
    expect(trashed.snapshot.trash[0]?.bytes).toEqual(Uint8Array.from([0, 255, 3]));

    const restored = apply(
      trashed.snapshot,
      request(
        [
          {
            kind: 'restore',
            resourceId: 'assets/old.bin',
            targetResourceId: 'assets/restored.bin',
          },
        ],
        'restore-old',
        trashed.snapshot.revision,
      ),
    );
    expect(restored.snapshot.active['assets/restored.bin']).toEqual(
      Uint8Array.from([0, 255, 3]),
    );
    expect(restored.snapshot.trash).toEqual([]);
  });

  test('keeps active and trash unchanged when restore target is occupied', () => {
    const initial = createInitialManifest(revision('revision-0'));
    const seeded = apply(
      initial,
      request(
        [
          { kind: 'put', resourceId: 'assets/old.bin', bytes: Uint8Array.from([1, 2]) },
          { kind: 'put', resourceId: 'assets/existing.bin', bytes: Uint8Array.from([9]) },
        ],
        'seed',
        initial.revision,
      ),
    );
    const trashed = apply(
      seeded.snapshot,
      request([{ kind: 'trash', resourceId: 'assets/old.bin' }], 'trash', seeded.snapshot.revision),
    ).snapshot;
    const before = structuredClone(trashed);

    const rejected = reduceResourceMutation(
      trashed,
      request(
        [{ kind: 'restore', resourceId: 'assets/old.bin', targetResourceId: 'assets/existing.bin' }],
        'restore-conflict',
        trashed.revision,
      ),
    );

    expect(rejected).toMatchObject({ ok: false, error: { code: 'resource-conflict' } });
    expect(trashed).toEqual(before);
  });

  test('keeps active, trash, and revision unchanged when the trash source is missing', () => {
    const initial = createInitialManifest(revision('revision-0'));
    const rejected = reduceResourceMutation(
      initial,
      request([{ kind: 'restore', resourceId: 'assets/missing.bin' }], 'missing', initial.revision),
    );

    expect(rejected).toMatchObject({ ok: false, error: { code: 'resource-not-found' } });
    expect(initial).toEqual(createInitialManifest(revision('revision-0')));
  });
});
