import { describe, expect, test } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildVersionGraph, listTagRefs, validateTagName } from '../src/version-control/graph';
import { compareAndSwapLatest } from '../src/version-control/latest-ref';

function git(root: string, args: string[]): string {
  return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
}

describe('version-control ancestry graph', () => {
  test('peels annotated and lightweight tags and merges same commits', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-graph-'));
    try {
      git(root, ['init', '--quiet']);
      git(root, ['config', 'user.name', 'Test']);
      git(root, ['config', 'user.email', 'test@example.invalid']);
      writeFileSync(join(root, 'file'), 'one');
      git(root, ['add', '.']);
      git(root, ['commit', '--quiet', '-m', 'one']);
      const first = git(root, ['rev-parse', 'HEAD']);
      git(root, ['tag', '-a', 'release-one', '-m', 'one']);
      git(root, ['tag', 'alias-one']);
      writeFileSync(join(root, 'file'), 'two');
      git(root, ['commit', '--quiet', '-am', 'two']);
      git(root, ['tag', '-a', 'release-two', '-m', 'two']);
      const refs = await listTagRefs(root);
      const graph = await buildVersionGraph(root);
      expect(refs.map((ref) => ref.tag)).toEqual(expect.arrayContaining(['release-one', 'alias-one', 'release-two']));
      expect(graph.nodes.filter((node) => node.commit === first)).toHaveLength(1);
      expect(graph.nodes.find((node) => node.commit === first)).toMatchObject({ message: 'one', committedAt: expect.any(Number) });
      expect(graph.edges.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('uses Git ref validation rather than tag ordering', () => {
    expect(validateTagName('release/2026-08')).toBe(true);
    expect(validateTagName('')).toBe(false);
    expect(validateTagName('-bad')).toBe(false);
    expect(validateTagName('a\0b')).toBe(false);
  });

  test('keeps an untagged refs/forgeax/latest tip in the graph', async () => {
    const root = mkdtempSync(join(tmpdir(), 'forgeax-graph-latest-'));
    try {
      git(root, ['init', '--quiet']);
      git(root, ['config', 'user.name', 'Test']);
      git(root, ['config', 'user.email', 'test@example.invalid']);
      writeFileSync(join(root, 'file'), 'one');
      git(root, ['add', '.']);
      git(root, ['commit', '--quiet', '-m', 'one']);
      const head = git(root, ['rev-parse', 'HEAD']);
      expect((await compareAndSwapLatest(root, null, head)).ok).toBe(true);
      const graph = await buildVersionGraph(root);
      expect(graph.nodes).toEqual(expect.arrayContaining([expect.objectContaining({ commit: head, latest: true, tags: [] })]));
      expect(graph.nodes.find((node) => node.commit === head)?.message).toBe('one');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
