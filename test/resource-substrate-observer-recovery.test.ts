import { describe, expect, test } from 'bun:test';
import {
  classifyPreparedRecovery,
  createObserverRecoveryIntent,
} from '../src/resource-substrate/recovery';

describe('resource observer recovery intent', () => {
  test('preserves the last-known-good revision while describing scoped recovery', () => {
    const intent = createObserverRecoveryIntent({
      rootId: 'game-main',
      scope: 'assets/characters',
      reason: 'observer-gap',
      lastKnownGoodRevision: 'resource:r7',
    });

    expect(intent).toEqual({
      kind: 'scoped-reconcile',
      rootId: 'game-main',
      scope: 'assets/characters',
      reason: 'observer-gap',
      lastKnownGoodRevision: 'resource:r7',
    });
  });

  test('keeps prepared recovery decisions explicit for before, after, and unknown HEAD', () => {
    expect(classifyPreparedRecovery('r1', 'r1', 'r2')).toEqual({ ok: true, value: 'keep-before' });
    expect(classifyPreparedRecovery('r1', 'r2', 'r2')).toEqual({ ok: true, value: 'keep-after' });
    const unknown = classifyPreparedRecovery('r1', 'r3', 'r2');
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.error.code).toBe('recovery-required');
  });
});
