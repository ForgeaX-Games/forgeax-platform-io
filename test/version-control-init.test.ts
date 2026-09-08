import { describe, expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeRepository } from '../src/version-control/init';
import { readRepositorySnapshot } from '../src/version-control/status';

describe('version-control initialization', () => {
  test('is idempotent, fills missing runtime ignores, and preserves user rules', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-init-'));
    try {
      writeFileSync(join(root, '.gitignore'), 'user-rule/\n');
      writeFileSync(join(root, 'scene.json'), '{}\n');
      const first = await initializeRepository(root);
      const firstIgnore = readFileSync(join(root, '.gitignore'), 'utf8');
      const second = await initializeRepository(root);
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe(firstIgnore);
      expect(firstIgnore).toContain('user-rule/');
      expect(firstIgnore).toContain('sessions/');
      expect(firstIgnore).toContain('.forgeax/ddc/');
      const snapshot = await readRepositorySnapshot(root);
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) expect(snapshot.head).toBe(null);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('ignores project DDC state in a newly initialized repository', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-init-ddc-'));
    try {
      const result = await initializeRepository(root);
      const ddcFile = join(root, '.forgeax', 'ddc', 'v2', 'runtime', 'scope.json');
      const { mkdirSync } = await import('node:fs');
      mkdirSync(join(root, '.forgeax', 'ddc', 'v2', 'runtime'), { recursive: true });
      writeFileSync(ddcFile, '{}\n');
      const snapshot = await readRepositorySnapshot(root);
      expect(result.ok).toBe(true);
      expect(snapshot.ok).toBe(true);
      if (snapshot.ok) {
        expect(snapshot.records.some((record) => record.path.includes('.forgeax/ddc'))).toBe(false);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('leaves the first preview able to see game files without creating a commit', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-init-preview-'));
    try {
      writeFileSync(join(root, 'scene.json'), '{}\n');
      const result = await initializeRepository(root);
      const snapshot = await readRepositorySnapshot(root);
      expect(result.ok).toBe(true);
      expect(snapshot.ok).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
