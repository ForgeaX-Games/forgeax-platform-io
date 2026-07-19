import { afterEach, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeAgentPack } from '../src/api/lib/agent-pack';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('writeAgentPack', () => {
  test('rejects traversal-like dot slugs', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-agent-pack-'));
    roots.push(projectRoot);

    for (const slug of ['.', '..']) {
      const result = writeAgentPack(
        { slug, manifest: {}, persona: 'Scout' },
        { scope: 'project', projectRoot },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('bad_input');
    }
    expect(existsSync(join(projectRoot, '.forgeax'))).toBe(false);
  });

  test('writes the canonical extension manifest filename', () => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'forgeax-agent-pack-'));
    roots.push(projectRoot);

    const result = writeAgentPack(
      {
        slug: 'agent-scout',
        manifest: { id: '@forgeax-extension/agent-scout', kind: 'agent' },
        persona: 'Scout',
      },
      { scope: 'project', projectRoot },
    );

    expect(result.ok).toBe(true);
    expect(existsSync(join(projectRoot, '.forgeax/extensions/agent-scout/forgeax-extension.json'))).toBe(true);
    expect(existsSync(join(projectRoot, '.forgeax/extensions/agent-scout/forgeax-plugin.json'))).toBe(false);
  });
});
