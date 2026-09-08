import { describe, expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { listTree } from '../src/api/lib/io';
import { singleGameFileBackend } from '../src/api/lib/file-backend';

describe('project DDC platform hygiene', () => {
  test('tree projection hides the whole .forgeax directory', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-tree-'));
    try {
      await mkdir(join(root, '.forgeax', 'ddc', 'v2'), { recursive: true });
      await writeFile(join(root, '.forgeax', 'ddc', 'v2', 'status.json'), '{}');
      await writeFile(join(root, 'scene.json'), '{}');
      const tree = await listTree(root, '', 4);
      expect(tree?.children?.map((entry) => entry.name)).not.toContain('.forgeax');
      expect(JSON.stringify(tree)).not.toContain('status.json');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('authored file access rejects DDC paths without inspecting DDC contents', async () => {
    const root = await mkdtemp(join(tmpdir(), 'forgeax-ddc-api-'));
    try {
      const game = join(root, 'same-name');
      await mkdir(join(game, '.forgeax', 'ddc', 'v2'), { recursive: true });
      const backend = singleGameFileBackend(game);
      expect(backend.resolveRead('same-name/.forgeax/ddc/v2/status.json')).toBeNull();
      expect(backend.resolveWrite('same-name/.forgeax/ddc/v2/status.json')).toBeNull();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
