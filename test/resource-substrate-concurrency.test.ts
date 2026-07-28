import { describe, expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openResourceRoot } from '../src/resource-substrate';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { createWriterLease } from '../src/resource-substrate/writer-lease';
import type { ResourceRoot } from '../src/resource-substrate/contract';

async function openPair(): Promise<{
  first: ResourceRoot;
  second: ResourceRoot;
  directory: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-concurrency-'));
  const store = createFilesystemResourceStore({ directory });
  const first = await openResourceRoot({ rootId: 'game-main', store });
  const second = await openResourceRoot({ rootId: 'game-main', store });
  expect(first.ok).toBe(true);
  expect(second.ok).toBe(true);
  if (!first.ok) throw first.error;
  if (!second.ok) throw second.error;
  return { first: first.value, second: second.value, directory };
}

describe('resource writer concurrency', () => {
  test('allows one writer and rejects the other stale revision', async () => {
    const opened = await openPair();
    try {
      const firstSnapshot = await opened.first.readSnapshot();
      const secondSnapshot = await opened.second.readSnapshot();
      expect(firstSnapshot.ok).toBe(true);
      expect(secondSnapshot.ok).toBe(true);
      if (!firstSnapshot.ok) throw firstSnapshot.error;
      if (!secondSnapshot.ok) throw secondSnapshot.error;

      const [first, second] = await Promise.all([
        opened.first.commit({
          identity: 'writer-one',
          expectedRevision: firstSnapshot.value.revision,
          changes: [{ kind: 'put', resourceId: 'assets/one.bin', bytes: Uint8Array.from([1]) }],
        }),
        opened.second.commit({
          identity: 'writer-two',
          expectedRevision: secondSnapshot.value.revision,
          changes: [{ kind: 'put', resourceId: 'assets/two.bin', bytes: Uint8Array.from([2]) }],
        }),
      ]);

      const results = [first, second];
      expect(results.filter((result) => result.ok)).toHaveLength(1);
      expect(results.filter((result) => !result.ok)).toHaveLength(1);
      const rejected = results.find((result) => !result.ok);
      expect(rejected).toMatchObject({
        ok: false,
        error: {
          code: 'stale-revision',
          actual: expect.any(String),
          hint: expect.any(String),
        },
      });

      const finalSnapshot = await opened.first.readSnapshot();
      expect(finalSnapshot.ok).toBe(true);
      if (!finalSnapshot.ok) throw finalSnapshot.error;
      expect(
        Boolean(finalSnapshot.value.active['assets/one.bin']) !==
          Boolean(finalSnapshot.value.active['assets/two.bin']),
      ).toBe(true);
      expect(Object.keys(finalSnapshot.value.active)).toHaveLength(1);
    } finally {
      await rm(opened.directory, { recursive: true, force: true });
    }
  });

  test('holds an exclusive lease until release and allows a safe stale takeover', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-lease-'));
    try {
      const firstManager = createWriterLease({ directory });
      const secondManager = createWriterLease({ directory });
      const first = await firstManager.acquire();
      expect(first.ok).toBe(true);
      if (!first.ok) throw first.error;

      const blocked = await secondManager.acquire();
      expect(blocked).toMatchObject({
        ok: false,
        error: { code: 'recovery-required', hint: expect.any(String) },
      });

      const released = await first.value.release();
      expect(released.ok).toBe(true);
      const afterRelease = await secondManager.acquire();
      expect(afterRelease.ok).toBe(true);
      if (!afterRelease.ok) throw afterRelease.error;
      await afterRelease.value.release();

      const staleManager = createWriterLease({
        directory,
        ownerPid: 999999,
        isProcessAlive: () => false,
        isPreparedStateDeterminate: () => true,
      });
      const stale = await staleManager.acquire();
      expect(stale.ok).toBe(true);
      if (!stale.ok) throw stale.error;
      await stale.value.release();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
