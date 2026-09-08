import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  resolveGitExecutable,
  validateGitExecutable,
  type GitExecutableCandidate,
} from '../src/version-control/executable';

describe('version-control git executable', () => {
  test('validates an absolute executable with git --version', async () => {
    const result = await validateGitExecutable(process.env.GIT_EXECUTABLE ?? 'git');
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.path.startsWith('/')).toBe(true);
  });

  test('preserves candidate precedence and rejects invalid paths', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-git-candidates-'));
    const invalid = join(root, 'not-git');
    writeFileSync(invalid, 'not an executable');
    const candidates: GitExecutableCandidate[] = [
      { source: 'saved', path: invalid },
      { source: 'path', path: process.env.GIT_EXECUTABLE ?? 'git' },
    ];
    const result = await resolveGitExecutable({ candidates });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.source).toBe('path');
  });

  test('does not install git or accept a non-executable candidate', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-git-unavailable-'));
    const dir = join(root, 'candidate-dir');
    mkdirSync(dir);
    const before = await resolveGitExecutable({ candidates: [{ source: 'manual', path: dir }] });
    expect(before.ok).toBe(false);
  });

  test('accepts a verified absolute manual path and ignores shell input', async () => {
    const result = await resolveGitExecutable({
      candidates: [{ source: 'manual', path: process.env.GIT_EXECUTABLE ?? 'git;touch hacked' }],
    });
    expect(result.ok).toBe(false);
  });
});
