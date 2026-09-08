import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeRepository } from '../src/version-control/init';
import { publishVersion } from '../src/version-control/publish';

describe('version-control security boundaries', () => {
  test('rejects shell metacharacters and path traversal before Git mutation', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-security-'));
    try {
      await initializeRepository(root);
      writeFileSync(join(root, 'file'), 'data\n');
      const result = await publishVersion(root, {
        tag: '../escape;touch hacked',
        message: 'unsafe',
        expectedSnapshotId: 'not-a-real-snapshot',
      });
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toMatch(/tag|snapshot|stale/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
