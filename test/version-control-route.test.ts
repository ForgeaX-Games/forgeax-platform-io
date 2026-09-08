import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createVersionControlRouter, validateVersionControlPayload } from '../src/api/game-host';

describe('version-control scoped routes', () => {
  test('uses a closed payload contract without cwd, argv, or executable', () => {
    expect(validateVersionControlPayload({ tag: 'release/one', message: 'one' })).toEqual({
      ok: true,
      value: { tag: 'release/one', message: 'one' },
    });
    expect(validateVersionControlPayload({ cwd: '/tmp', argv: ['status'] })).toMatchObject({ ok: false });
    expect(validateVersionControlPayload({ executable: '/bin/sh' })).toMatchObject({ ok: false });
  });

  test('exposes snapshot and closed command paths from a game-scoped router', async () => {
    const router = createVersionControlRouter({ gameRoot: '/tmp/does-not-exist' });
    const snapshot = await router.request('/snapshot');
    expect(snapshot.status).toBe(200);
    expect(await snapshot.json()).toMatchObject({ status: 'uninitialized' });
    const rejected = await router.request('/commands/publish', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: '/tmp', argv: ['status'] }),
    });
    expect(rejected.status).toBe(400);
  });

  test('routes real initialize, status, configure, publish, graph, and switch commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-route-owner-'));
    try {
      const router = createVersionControlRouter({ gameRoot: root });
      const initialized = await router.request('/commands/initializeGameRepository', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'route-init' }),
      });
      expect(initialized.status).toBe(200);
      writeFileSync(join(root, 'scene.json'), '{"version":1}\n');
      const status = await router.request('/commands/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const statusBody = await status.json() as { ok: boolean; value?: { snapshotId: string; status: string } };
      expect(statusBody.value?.status).toBe('ready');
      const configured = await router.request('/commands/configureGitExecutable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ candidatePath: '/usr/bin/git', requestId: 'route-configure' }),
      });
      expect([200, 503]).toContain(configured.status);
      const autoConfigured = await router.request('/commands/configureGitExecutable', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ requestId: 'route-configure-auto' }),
      });
      expect([200, 503]).toContain(autoConfigured.status);
      const firstSnapshot = statusBody.value!;
      const published = await router.request('/commands/publishGameVersion', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'route/one', message: 'route one', expectedSnapshotId: firstSnapshot.snapshotId, requestId: 'route-publish-one' }),
      });
      expect(published.status).toBe(200);
      writeFileSync(join(root, 'scene.json'), '{"version":2}\n');
      const secondStatus = await router.request('/commands/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const secondBody = await secondStatus.json() as { value: { snapshotId: string } };
      const publishedTwo = await router.request('/commands/publishGameVersion', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'route/two', message: 'route two', expectedSnapshotId: secondBody.value.snapshotId, requestId: 'route-publish-two' }),
      });
      expect(publishedTwo.status).toBe(200);
      const graph = await router.request('/commands/graph', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const graphBody = await graph.json() as { value: { graph: { nodes: Array<{ tags?: string[]; message?: string; committedAt?: number }>; edges: unknown[] } } };
      expect(graph.status).toBe(200);
      expect(graphBody.value.graph.nodes.flatMap((node) => node.tags ?? [])).toEqual(expect.arrayContaining(['route/one', 'route/two']));
      expect(graphBody.value.graph.nodes).toEqual(expect.arrayContaining([
        expect.objectContaining({ tags: ['route/one'], message: 'route one', committedAt: expect.any(Number) }),
        expect.objectContaining({ tags: ['route/two'], message: 'route two', committedAt: expect.any(Number) }),
      ]));
      const publishedOneBody = await published.json() as { value: { commitIdentity: string } };
      const switched = await router.request('/commands/switchGameVersion', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ tag: 'route/one', expectedCommit: publishedOneBody.value.commitIdentity, requestId: 'route-switch-one' }),
      });
      expect(switched.status).toBe(200);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('replays the same request and rejects a payload conflict', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-route-replay-'));
    try {
      const router = createVersionControlRouter({ gameRoot: root });
      await router.request('/commands/init', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ requestId: 'replay-init' }) });
      writeFileSync(join(root, 'scene.json'), '{}\n');
      const status = await router.request('/commands/status', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const snapshot = await status.json() as { value: { snapshotId: string } };
      const request = { tag: 'replay/one', message: 'same', expectedSnapshotId: snapshot.value.snapshotId, requestId: 'replay-publish' };
      const first = await router.request('/commands/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const firstBody = await first.json() as { value: { commitIdentity: string } };
      const replay = await router.request('/commands/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request) });
      const replayBody = await replay.json() as { value: { commitIdentity: string } };
      expect(replay.status).toBe(200);
      expect(replayBody.value.commitIdentity).toBe(firstBody.value.commitIdentity);
      const conflict = await router.request('/commands/publish', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...request, message: 'different' }) });
      const conflictBody = await conflict.json() as { error?: { code?: string } };
      expect(conflict.status).toBe(409);
      expect(conflictBody.error?.code).toBe('version-control-request-conflict');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
