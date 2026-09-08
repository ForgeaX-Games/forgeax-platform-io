import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { inspectRepositoryRoot } from '../src/version-control/root';

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-root-'));
  execFileSync('git', ['init', '--quiet', root]);
  return root;
}

describe('version-control repository root', () => {
  test('accepts only the direct .git of the game root', async () => {
    const outer = repo();
    const game = join(outer, 'game');
    mkdirSync(game);
    execFileSync('git', ['init', '--quiet', game]);
    const identity = await inspectRepositoryRoot(game);
    expect(identity.ok).toBe(true);
    if (identity.ok) expect(identity.realPath).toBe(realpathSync(game));
  });

  test('does not adopt an enclosing repository', async () => {
    const outer = repo();
    const game = join(outer, 'game');
    mkdirSync(game);
    const identity = await inspectRepositoryRoot(game);
    expect(identity.ok).toBe(false);
  });
});
