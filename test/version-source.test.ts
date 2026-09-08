import { afterEach, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function inspectVersion(checkout: boolean, nested = false) {
  const root = mkdtempSync(join(tmpdir(), 'forgeax-version-source-'));
  roots.push(root);
  const trace = join(root, 'git-calls.txt');
  const bin = join(root, 'bin');
  mkdirSync(bin);
  if (checkout) {
    const git = (args: string[]) => {
      const result = spawnSync('git', ['-c', 'core.hooksPath=', ...args], { cwd: root, encoding: 'utf8' });
      expect(result.status).toBe(0);
    };
    git(['init', '-b', 'release20260901']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty', '--no-gpg-sign', '-m', 'fixture']);
    git(['tag', 'v1']);
    writeFileSync(join(root, '.gitmodules'), '');
  } else {
    const executable = join(bin, process.platform === 'win32' ? 'git.cmd' : 'git');
    writeFileSync(executable, process.platform === 'win32'
      ? '@echo off\r\necho x>>"%FORGEAX_GIT_PROBE_LOG%"\r\nexit /b 1\r\n'
      : '#!/bin/sh\nprintf x >> "$FORGEAX_GIT_PROBE_LOG"\nexit 1\n');
    if (process.platform !== 'win32') chmodSync(executable, 0o755);
  }
  const cwd = nested ? join(root, 'packages', 'server') : root;
  mkdirSync(cwd, { recursive: true });
  // Use a separate process so the module cache and checkout watchers cannot
  // affect other tests. The packaged case records any real executable launch.
  const script = `
    const { getVersion, getVersionTags } = await import(${JSON.stringify(new URL('../src/api/version.ts', import.meta.url).href)});
    const version = getVersion();
    const tags = getVersionTags();
    console.log(JSON.stringify({ version, tags }));
    process.exit(0);
  `;
  const result = spawnSync(process.execPath, ['-e', script], {
    cwd,
    env: { ...process.env, FORGEAX_VERSION: 'desktop-test-version', FORGEAX_GIT_PROBE_LOG: trace,
      PATH: checkout ? process.env.PATH : bin + delimiter + process.env.PATH },
    encoding: 'utf8',
    timeout: 5000,
  });
  expect(result.status).toBe(0);
  return { calls: existsSync(trace) ? readFileSync(trace, 'utf8') : '', ...JSON.parse(result.stdout) };
}

test('a packaged directory never spawns Git for version or tag polling', () => {
  const result = inspectVersion(false);
  expect(result.calls).toBe('');
  expect(result.version.version).toBe('desktop-test-version');
  expect(result.tags).toEqual([]);
});

test('live source checkout version and tags still take precedence over boot metadata', () => {
  const result = inspectVersion(true, true);
  expect(result.version.totalCommits).toBe(1);
  expect(result.version.version).toMatch(/^v0\..*\.1$/);
  expect(result.version.branch).toBe('release20260901');
  expect(result.tags).toHaveLength(1);
  expect(result.tags[0].tag).toBe('v1');
});
