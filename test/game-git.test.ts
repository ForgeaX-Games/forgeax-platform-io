import { afterEach, describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createVersion } from '../src/api/lib/game-git';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('game Git isolation', () => {
  test('ignores inherited hooks and tag signing requirements', () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-game-git-hooks-'));
    roots.push(root);
    const game = join(root, 'game');
    const hooks = join(root, 'ambient-hooks');
    const globalConfig = join(root, 'global.gitconfig');
    const marker = join(root, 'hook-ran');
    mkdirSync(game);
    mkdirSync(hooks);
    writeFileSync(join(game, 'project.json'), '{"id":"fixture"}\n');
    writeFileSync(
      join(hooks, 'pre-commit'),
      '#!/bin/sh\nprintf invoked > "$FORGEAX_TEST_HOOK_MARKER"\nexit 91\n',
    );
    chmodSync(join(hooks, 'pre-commit'), 0o755);
    execFileSync('git', ['config', '--file', globalConfig, 'core.hooksPath', hooks]);
    execFileSync('git', ['config', '--file', globalConfig, 'tag.gpgSign', 'true']);
    execFileSync('git', ['config', '--file', globalConfig, 'gpg.program', 'false']);

    const previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL;
    const previousMarker = process.env.FORGEAX_TEST_HOOK_MARKER;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    process.env.FORGEAX_TEST_HOOK_MARKER = marker;
    try {
      expect(createVersion(game)).toMatchObject({ tag: 'v1' });
      expect(existsSync(marker)).toBe(false);
    } finally {
      if (previousGlobalConfig === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig;
      if (previousMarker === undefined) delete process.env.FORGEAX_TEST_HOOK_MARKER;
      else process.env.FORGEAX_TEST_HOOK_MARKER = previousMarker;
    }
  });
});
