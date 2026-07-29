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
    await writeFile(targetFile, 'file');
    await symlink(targetDir, join(root, 'linked-dir'), 'dir');
    await symlink(targetFile, join(root, 'linked-file'), 'file');
    await symlink(join(root, 'missing'), join(root, 'dangling'), 'dir');

    const response = await createFsBrowserRouter().request(
      `http://localhost/browse?dir=${encodeURIComponent(root)}`,
    );
    const body = await response.json() as { entries: Array<{ name: string }> };

    expect(response.status).toBe(200);
    expect(body.entries.map((entry) => entry.name)).toEqual([
      '.hidden-dir',
      'linked-dir',
      'real-dir',
      'target-dir',
    ]);
  });
});
