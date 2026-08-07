import { afterEach, describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createForgeaxVersionAdapter } from '../../src/workbench/version-adapter';

const roots: string[] = [];

async function gameRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-version-adapter-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createForgeaxVersionAdapter', () => {
  test('maps existing vN Git semantics without checking out history', async () => {
    const root = await gameRoot();
    const adapter = createForgeaxVersionAdapter();

    expect(await adapter.currentVersion(root)).toBeNull();
    await adapter.ensureRepository(root);
    await writeFile(join(root, 'project.json'), '{"title":"Cut"}\n');
    await writeFile(join(root, 'blueprint.json'), '{"cut":1}\n');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'manifest.json'), '{"assets":[]}\n');

    const v1 = await adapter.createVersion(root, 'first cut');
    expect(v1.tag).toBe('v1');
    expect(v1.message).toBe('first cut');
    expect(Date.parse(v1.createdAt)).not.toBeNaN();

    await writeFile(join(root, 'blueprint.json'), '{"cut":2}\n');
    const dirty = await adapter.currentVersion(root);
    expect(dirty).toMatchObject({ tag: 'v1', dirty: true });

    const v2 = await adapter.createVersion(root, 'second cut');
    expect(v2.tag).toBe('v2');
    expect((await adapter.listVersions(root)).map((version) => version.tag)).toEqual(['v2', 'v1']);
    expect(new TextDecoder().decode(
      await adapter.readFileAtVersion(root, 'v1', 'blueprint.json') ?? undefined,
    )).toBe('{"cut":1}\n');
    expect(await adapter.currentVersion(root)).toMatchObject({ tag: 'v2', dirty: false });
  });

  test('creates idempotent tip checkpoints without adding a vN version', async () => {
    const root = await gameRoot();
    const adapter = createForgeaxVersionAdapter();
    await adapter.ensureRepository(root);
    await writeFile(join(root, 'project.json'), '{"title":"Tip"}\n');
    await writeFile(join(root, 'blueprint.json'), '{"cut":1}\n');
    await mkdir(join(root, 'assets'));
    await writeFile(join(root, 'assets', 'manifest.json'), '{"assets":[]}\n');

    const checkpoint = await adapter.createCheckpoint(root, 'close tip');

    expect(checkpoint).toMatchObject({ message: 'close tip', created: true });
    expect(Date.parse(checkpoint.createdAt)).not.toBeNaN();
    expect(await adapter.listVersions(root)).toEqual([]);
    await expect(adapter.createCheckpoint(root, 'close retry')).resolves.toMatchObject({
      commitHash: checkpoint.commitHash,
      message: 'close retry',
      created: false,
    });
  });

  test('rejects traversal and invalid version selectors', async () => {
    const root = await gameRoot();
    const adapter = createForgeaxVersionAdapter();
    await adapter.ensureRepository(root);

    await expect(adapter.readFileAtVersion(root, '../v1', 'blueprint.json')).rejects.toThrow();
    await expect(adapter.readFileAtVersion(root, 'v1', '../outside')).rejects.toThrow();
  });
});
