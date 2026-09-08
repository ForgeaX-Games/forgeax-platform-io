import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { initializeRepository } from '../src/version-control/init';
import { checkoutDetached } from '../src/version-control/checkout';

describe('game version-control integration security', () => {
  test('rejects dirty worktrees before detached checkout', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-vc-security-'));
    try {
      await initializeRepository(root);
      writeFileSync(join(root, 'untracked.txt'), 'must remain\n');
      const result = await checkoutDetached(root, { tag: 'release/one', expectedCommit: '0'.repeat(40) });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error.code).toBe('version-control-worktree-dirty');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
