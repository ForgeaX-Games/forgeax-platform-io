import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { GameFileCapability, VersionAdapter } from '@forgeax/workbench-host/contracts';
import { createForgeaxWorkspaceAdapter } from '../../src/workbench/workspace-adapter';
import { createForgeaxVersionAdapter } from '../../src/workbench/version-adapter';

const roots: string[] = [];

async function projectRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-workspace-adapter-'));
  roots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createForgeaxWorkspaceAdapter', () => {
  test('anchors file and version operations under .forgeax/games', async () => {
    const root = await projectRoot();
    const workspace = createForgeaxWorkspaceAdapter({ projectRoot: root });
    const versions = createForgeaxVersionAdapter();
    let retained: GameFileCapability | undefined;

    await workspace.withGameRoot('video-game', { create: true, versioning: versions }, async (scope) => {
      expect(scope.gameRoot).toBe(join(root, '.forgeax', 'games', 'video-game'));
      await scope.files.write('nested/data.json', new TextEncoder().encode('{"ok":true}\n'));
      await scope.files.write('project.json', new TextEncoder().encode('{"title":"Video"}\n'));
      await scope.files.write('blueprint.json', new TextEncoder().encode('{"scenes":[]}\n'));
      await scope.files.write(
        'assets/manifest.json',
        new TextEncoder().encode('{"assets":[]}\n'),
      );
      expect(await scope.files.list('nested')).toEqual(['data.json']);
      expect(new TextDecoder().decode(await scope.files.read('nested/data.json') ?? undefined))
        .toBe('{"ok":true}\n');
      await scope.versions.ensureRepository();
      const v1 = await scope.versions.createVersion('first');
      expect(v1.tag).toBe('v1');
      await expect(scope.versions.createCheckpoint('tip')).resolves.toMatchObject({
        commitHash: v1.commitHash,
        created: false,
      });
      retained = scope.files;
    });

    await expect(retained!.read('nested/data.json')).rejects.toThrow(/no longer active/);
    expect(await workspace.resolveGameRoot('video-game'))
      .toBe(join(root, '.forgeax', 'games', 'video-game'));
  });

  test('rejects traversal, missing roots, and symlink escapes', async () => {
    const root = await projectRoot();
    const workspace = createForgeaxWorkspaceAdapter({ projectRoot: root });
    const versions = createForgeaxVersionAdapter();

    await expect(workspace.resolveGameRoot('../outside')).rejects.toThrow();
    await expect(workspace.withGameRoot(
      'missing-game',
      { create: false, versioning: versions },
      async () => undefined,
    )).rejects.toMatchObject({ code: 'ENOENT' });

    const games = join(root, '.forgeax', 'games');
    const outside = join(root, 'outside');
    await mkdir(games, { recursive: true });
    await mkdir(outside);
    await symlink(outside, join(games, 'linked-game'));
    await expect(workspace.resolveGameRoot('linked-game')).rejects.toThrow(/symbolic link/);
  });

  test('anchors a launcher-managed packages/games projection to its canonical target', async () => {
    const root = await projectRoot();
    const games = join(root, '.forgeax', 'games');
    const source = join(root, 'packages', 'games', 'shared-game');
    const outside = join(root, 'outside');
    const link = join(games, 'shared-game');
    await mkdir(source, { recursive: true });
    await mkdir(outside);
    await mkdir(games, { recursive: true });
    await writeFile(join(source, 'project.json'), '{"source":"package"}\n');
    await symlink(source, link);
    const workspace = createForgeaxWorkspaceAdapter({ projectRoot: root });

    expect(await workspace.resolveGameRoot('shared-game')).toBe(link);
    await workspace.withGameRoot(
      'shared-game',
      { create: true, versioning: {} as VersionAdapter },
      async ({ gameRoot, files }) => {
        expect(gameRoot).toBe(link);
        expect(new TextDecoder().decode(await files.read('project.json') ?? undefined))
          .toBe('{"source":"package"}\n');
        await unlink(link);
        await symlink(outside, link);
        await files.write('anchored.json', new TextEncoder().encode('{"ok":true}\n'));
      },
    );

    expect(await Bun.file(join(source, 'anchored.json')).text()).toBe('{"ok":true}\n');
    expect(await Bun.file(join(outside, 'anchored.json')).exists()).toBe(false);
  });

  test('serializes matching file locks', async () => {
    const root = await projectRoot();
    const workspace = createForgeaxWorkspaceAdapter({ projectRoot: root });
    const noVersions = {} as VersionAdapter;
    const order: string[] = [];

    await workspace.withGameRoot('lock-game', { create: true, versioning: noVersions }, async ({ files }) => {
      let release!: () => void;
      const gate = new Promise<void>((resolve) => { release = resolve; });
      const first = files.withLocks(['b', 'a'], async () => {
        order.push('first:start');
        await gate;
        order.push('first:end');
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const second = files.withLocks(['a'], async () => {
        order.push('second');
      });
      release();
      await Promise.all([first, second]);
    });

    expect(order).toEqual(['first:start', 'first:end', 'second']);
  });
});
