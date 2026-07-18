import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename, join } from 'node:path';
import { singleGameFileBackend, studioFileBackend, WHITELIST_ERROR } from '../src/api/lib/file-backend';

// singleGameFileBackend is the R3 confinement seam: the standalone editor opens
// ONE game at an arbitrary dir, addressed by client-space `<slug>/<rel>`. This
// suite locks (a) the slug-strip + dir-confinement mapping and (b) traversal
// rejection, so a future refactor can't widen the standalone editor's reach.

let tmp: string;     // a parent holding the game dir + a sibling secret
let gameDir: string; // the --game <dir>
let slug: string;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fx-fb-'));
  gameDir = resolve(tmp, 'my-game');
  slug = basename(gameDir);
  await mkdir(resolve(gameDir, 'scenes'), { recursive: true });
  await writeFile(resolve(gameDir, 'forge.json'), '{"name":"my-game"}');
  await writeFile(resolve(gameDir, 'scenes', 'main.pack.json'), '{"v":1}');
  // a sibling the game must NOT be able to reach via traversal
  await writeFile(resolve(tmp, 'secret.txt'), 'top secret');
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('singleGameFileBackend — slug-rooted confinement', () => {
  test('resolveRead/Write map `<slug>/<rel>` to disk under the game dir', () => {
    const b = singleGameFileBackend(gameDir);
    expect(b.resolveRead(`${slug}/forge.json`)).toBe(resolve(gameDir, 'forge.json'));
    expect(b.resolveWrite(`${slug}/scenes/main.pack.json`)).toBe(
      resolve(gameDir, 'scenes', 'main.pack.json'),
    );
    // bare slug → the game root itself
    expect(b.resolveRead(slug)).toBe(gameDir);
  });

  test.each([
    { name: 'empty', input: '' },
    { name: 'wrong slug', input: 'other-game/forge.json' },
    { name: 'parent escape', input: `${slug}/../secret.txt` },
    { name: 'deep escape', input: `${slug}/scenes/../../secret.txt` },
    { name: 'null byte', input: `${slug}/forge\0.json` },
  ])('rejects $name → null (read & write)', ({ input }) => {
    const b = singleGameFileBackend(gameDir);
    expect(b.resolveRead(input)).toBeNull();
    expect(b.resolveWrite(input)).toBeNull();
  });

  test('tree("") and tree(slug) walk the game, paths in client space (slug/…)', async () => {
    const b = singleGameFileBackend(gameDir);
    for (const root of ['', slug]) {
      const res = await b.tree(root);
      expect(res.ok).toBe(true);
      if (!res.ok) continue;
      expect(res.tree.path).toBe(slug);
      const names = (res.tree.children ?? []).map((n) => n.name).sort();
      expect(names).toContain('forge.json');
      expect(names).toContain('scenes');
      const scenes = (res.tree.children ?? []).find((n) => n.name === 'scenes');
      expect(scenes?.path).toBe(`${slug}/scenes`);
    }
  });

  test('tree() rejects a root not addressing this game → 400', async () => {
    const b = singleGameFileBackend(gameDir);
    const res = await b.tree('other-game');
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.status).toBe(400);
  });
});

describe('studioFileBackend — preserves the whitelist contract', () => {
  test('write outside whitelist → null (handler maps to 400 WHITELIST_ERROR)', () => {
    const b = studioFileBackend();
    expect(b.resolveWrite('secrets/key.json')).toBeNull();
    expect(WHITELIST_ERROR).toContain('whitelist');
  });
});
