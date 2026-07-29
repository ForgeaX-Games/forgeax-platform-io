import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFsBrowserRouter } from './fs-browser';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('GET /browse', () => {
  test('lists real directories and directory symlinks only', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-fs-browser-'));
    roots.push(root);
    const targetDir = join(root, 'target-dir');
    const targetFile = join(root, 'target-file');
    await mkdir(targetDir);
    await mkdir(join(root, 'real-dir'));
    await mkdir(join(root, '.hidden-dir'));
    await mkdir(join(root, 'forge-game'));
    await writeFile(join(root, 'forge-game', 'forge.json'), '{}');
    await mkdir(join(root, 'main-game'));
    await writeFile(join(root, 'main-game', 'main.ts'), 'export {};');
    await mkdir(join(root, 'legacy-games-container', 'games'), { recursive: true });
    await writeFile(targetFile, 'file');
    await symlink(targetDir, join(root, 'linked-dir'), 'dir');
    await symlink(targetFile, join(root, 'linked-file'), 'file');
    await symlink(join(root, 'missing'), join(root, 'dangling'), 'dir');

    const response = await createFsBrowserRouter().request(
      `http://localhost/browse?dir=${encodeURIComponent(root)}`,
    );
    const body = await response.json() as {
      entries: Array<{ name: string; hasGame: boolean }>;
      selfHasGame: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.entries.map((entry) => entry.name)).toEqual([
      '.hidden-dir',
      'forge-game',
      'legacy-games-container',
      'linked-dir',
      'main-game',
      'real-dir',
      'target-dir',
    ]);
    expect(Object.fromEntries(body.entries.map((entry) => [entry.name, entry.hasGame]))).toEqual({
      '.hidden-dir': false,
      'forge-game': true,
      'legacy-games-container': false,
      'linked-dir': false,
      'main-game': true,
      'real-dir': false,
      'target-dir': false,
    });
    expect(body.selfHasGame).toBe(false);
  });
});
