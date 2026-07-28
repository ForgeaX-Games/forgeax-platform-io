import { describe, expect, test } from 'bun:test';
import type {
  ResourceMutation,
  ResourceMutationRecord,
  ResourceRevision,
} from '../src/resource-substrate/contract';
import {
  createInitialManifest,
  reduceResourceMutation,
} from '../src/resource-substrate/manifest';

const revision = (value: string) => value as ResourceRevision;

function mutation(
  identity: string,
  expectedRevision: ResourceRevision,
  value: number,
): ResourceMutation {
  return {
    identity,
    expectedRevision,
    changes: [{ kind: 'put', resourceId: 'assets/item.bin', bytes: Uint8Array.from([value]) }],
  };
}

describe('resource mutation identity semantics', () => {
  test('canonical request digest is repeatable and independent of object identity', () => {
    const first = mutation('save-1', revision('revision-0'), 7);
    const second = structuredClone(first);
    const firstResult = reduceResourceMutation(
      createInitialManifest(revision('revision-0')),
      first,
    );
    const secondResult = reduceResourceMutation(
      createInitialManifest(revision('revision-0')),
      second,
    );

    expect(firstResult).toMatchObject({ ok: true });
    expect(secondResult).toMatchObject({ ok: true });
    if (!firstResult.ok || !secondResult.ok) return;
    expect(firstResult.value.requestDigest).toBe(secondResult.value.requestDigest);
    expect(firstResult.value.snapshot).toEqual(secondResult.value.snapshot);
  });

  test('replays the same terminal result before checking the current revision', () => {
    const initial = createInitialManifest(revision('revision-0'));
    const firstRequest = mutation('save-1', initial.revision, 7);
    const first = reduceResourceMutation(initial, firstRequest);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;

    const record: ResourceMutationRecord = {
      identity: firstRequest.identity as ResourceMutationRecord['identity'],
      requestDigest: first.value.requestDigest,
      result: first.value.result,
    };
    const advanced = reduceResourceMutation(
      first.value.snapshot,
      mutation('save-2', first.value.snapshot.revision, 8),
      [record],
    );
    expect(advanced).toMatchObject({ ok: true });
    if (!advanced.ok) return;

    const replay = reduceResourceMutation(
      advanced.value.snapshot,
      firstRequest,
      [record],
    );
    expect(replay).toMatchObject({ ok: true });
    if (!replay.ok) return;
    expect(replay.value.result).toEqual(first.value.result);
    expect(replay.value.snapshot).toEqual(advanced.value.snapshot);
  });

  test('rejects identity reuse with different content without writing', () => {
    const initial = createInitialManifest(revision('revision-0'));
    const firstRequest = mutation('save-1', initial.revision, 7);
    const first = reduceResourceMutation(initial, firstRequest);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;

    const record: ResourceMutationRecord = {
      identity: firstRequest.identity as ResourceMutationRecord['identity'],
      requestDigest: first.value.requestDigest,
      result: first.value.result,
    };
    const rejected = reduceResourceMutation(
      first.value.snapshot,
      mutation('save-1', first.value.snapshot.revision, 9),
      [record],
    );

    expect(rejected).toMatchObject({ ok: false, error: { code: 'identity-conflict' } });
  });

  test('distinguishes a new stale request from a legal identity replay', () => {
    const initial = createInitialManifest(revision('revision-0'));
    const firstRequest = mutation('save-1', initial.revision, 7);
    const first = reduceResourceMutation(initial, firstRequest);
    expect(first).toMatchObject({ ok: true });
    if (!first.ok) return;

    const stale = reduceResourceMutation(
      first.value.snapshot,
      mutation('save-2', revision('revision-0'), 9),
      [],
    );
    expect(stale).toMatchObject({ ok: false, error: { code: 'stale-revision' } });
  });
});
