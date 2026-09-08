import { describe, expect, test } from 'bun:test';
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseChangelog } from '../src/api/changelog';
import {
  readStudioRuntimePorts,
  resolveStudioRuntimePorts,
  studioRuntimePortsFromEnv,
} from '../src/api/runtime-manifest';

describe('parseChangelog', () => {
  test('parses v0.M.D headings with title on the next line', () => {
    const raw = `# header\n\n## v0.3.22 — 2026-07-24\n\n**Play fixes**\n\n- item\n\n---\n\n## v0.3.21 — 2026-07-22\n\n**Older**\n`;
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      version: 'v0.3.22',
      date: '2026-07-24',
      title: 'Play fixes',
      body: '- item',
    });
  });

  test('parses legacy v0.M.D.N headings with inline title and metadata', () => {
    const raw = [
      '## v0.5.24.651 — 2026-05-24 · Phase 2 closeout',
      '',
      '**代码增量**:main +1',
      '**主题**:summary line',
      '',
      '- bullet',
    ].join('\n');
    const entries = parseChangelog(raw);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      version: 'v0.5.24.651',
      date: '2026-05-24',
      title: 'Phase 2 closeout',
      delta: 'main +1',
      theme: 'summary line',
      body: '- bullet',
    });
  });

  test('sorts entries by date descending, then version descending', () => {
    const raw = [
      '## v0.3.20 — 2026-07-18',
      '',
      '**Older July**',
      '',
      '---',
      '',
      '## v0.3.30 — 2026-08-25',
      '',
      '**Newest**',
      '',
      '---',
      '',
      '## v0.5.24.651 — 2026-05-24 · Legacy may',
      '',
      '**May**',
    ].join('\n');
    const entries = parseChangelog(raw);
    expect(entries.map((e) => e.version)).toEqual([
      'v0.3.30',
      'v0.3.20',
      'v0.5.24.651',
    ]);
  });
});

describe('runtime-manifest', () => {
  const root = join(tmpdir(), `runtime-manifest-${process.pid}`);

  test('reads ports from forgeax runtime manifest', () => {
    const manifestDir = join(root, '.forgeax', 'runtime');
    rmSync(root, { recursive: true, force: true });
    mkdirSync(manifestDir, { recursive: true });
    writeFileSync(join(manifestDir, 'manifest.json'), JSON.stringify({
      endpoints: {
        server: { port: 28900 },
        interface: { port: 28920 },
        engine: { port: 25173 },
      },
    }));
    expect(readStudioRuntimePorts(root)).toEqual({ server: 28900, ui: 28920, engine: 25173 });
  });

  test('falls back to env when manifest is absent', () => {
    const missing = join(root, 'missing');
    rmSync(missing, { recursive: true, force: true });
    expect(resolveStudioRuntimePorts(missing, {
      FORGEAX_SERVER_PORT: '19900',
      FORGEAX_INTERFACE_PORT: '19920',
      FORGEAX_ENGINE_PORT: '19973',
    })).toEqual({ server: 19900, ui: 19920, engine: 19973 });
  });

  test('uses source defaults when manifest and env are absent', () => {
    expect(studioRuntimePortsFromEnv({})).toEqual({ server: 18900, ui: 18920, engine: 15173 });
  });
});
