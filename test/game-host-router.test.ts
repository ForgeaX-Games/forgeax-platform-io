import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { createGameHostRouter } from '../src/api/game-host';

// game-host round-trips a game package through .forgeax/games/<slug>/ and tags
// versions as annotated vN in that dir's own git repo.

let tmp: string;
let prevRoot: string | undefined;
let router: ReturnType<typeof createGameHostRouter>;
const SLUG = 'my-video-game';

const sampleBlueprint = {
  version: 'wb-game-video.graph.v1',
  manifest: { mainPackId: 'main', packs: { main: { id: 'main', title: 'x', entry: 'a', graph: { nodes: [], edges: [] } } } },
  graph: { nodes: [], edges: [] },
};

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fx-game-host-'));
  await mkdir(resolve(tmp, '.forgeax', 'games', SLUG), { recursive: true });
  prevRoot = process.env.FORGEAX_PROJECT_ROOT;
  process.env.FORGEAX_PROJECT_ROOT = tmp;
  router = createGameHostRouter();
});

afterAll(async () => {
  if (prevRoot === undefined) delete process.env.FORGEAX_PROJECT_ROOT;
  else process.env.FORGEAX_PROJECT_ROOT = prevRoot;
  await rm(tmp, { recursive: true, force: true });
});

const gameRoot = () => resolve(tmp, '.forgeax', 'games', SLUG);

describe('PUT/GET /games/:slug/package', () => {
  test('PUT writes project.json + blueprint.json + assets/manifest.json', async () => {
    const res = await router.request(`/games/${SLUG}/package`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprint: sampleBlueprint }),
    });
    expect(res.status).toBe(200);
    expect(existsSync(resolve(gameRoot(), 'project.json'))).toBe(true);
    expect(existsSync(resolve(gameRoot(), 'blueprint.json'))).toBe(true);
    expect(existsSync(resolve(gameRoot(), 'assets', 'manifest.json'))).toBe(true);

    // project.json auto-synthesized with entry.blueprint pointer
    const project = JSON.parse(await readFile(resolve(gameRoot(), 'project.json'), 'utf-8'));
    expect(project.id).toBe(SLUG);
    expect(project.entry.blueprint).toBe('blueprint.json');
  });

  test('GET returns the same blueprint back', async () => {
    const res = await router.request(`/games/${SLUG}/package`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.blueprint).toEqual(sampleBlueprint);
    expect(body.project.id).toBe(SLUG);
    expect(body.assetsManifest).toEqual({ assets: {} });
  });

  test('PUT without blueprint → 400', async () => {
    const res = await router.request(`/games/${SLUG}/package`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project: { id: SLUG } }),
    });
    expect(res.status).toBe(400);
  });

  test('invalid slug → 400', async () => {
    const res = await router.request('/games/BAD_SLUG/package');
    expect(res.status).toBe(400);
  });

  test('caller-provided project + manifest are persisted verbatim', async () => {
    const project = { id: SLUG, title: 'Custom', platform: 'wb-game-video', platformVersion: '1', entry: { blueprint: 'blueprint.json', components: 'dist/components' } };
    const assetsManifest = { assets: { clip1: { url: 'https://cdn.example/clip1.mp4', kind: 'video' } } };
    const res = await router.request(`/games/${SLUG}/package`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ project, blueprint: sampleBlueprint, assetsManifest }),
    });
    expect(res.status).toBe(200);
    const get = await (await router.request(`/games/${SLUG}/package`)).json();
    expect(get.project.title).toBe('Custom');
    expect(get.assetsManifest).toEqual(assetsManifest);
  });
});

describe('versions', () => {
  test('current on a fresh (no-git) game → nulls', async () => {
    const res = await router.request(`/games/${SLUG}/versions/current`);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.tag).toBeNull();
    expect(body.commitHash).toBeNull();
  });

  test('first POST versions → v1 (staged changes committed + annotated tag)', async () => {
    const v1 = await (await router.request(`/games/${SLUG}/versions`, { method: 'POST' })).json();
    expect(v1.tag).toBe('v1');
    expect(typeof v1.commitHash).toBe('string');
    expect(v1.commitHash.length).toBeGreaterThan(0);
  });

  test('POST versions with NO changes → no new version (returns current, unchanged)', async () => {
    const again = await (await router.request(`/games/${SLUG}/versions`, { method: 'POST' })).json();
    expect(again.tag).toBe('v1');
    expect(again.unchanged).toBe(true);
  });

  test('after a change, POST versions → v2', async () => {
    // mutate the blueprint so there are staged changes
    const changed = { ...sampleBlueprint, graph: { nodes: [{ id: 'n1' }], edges: [] } };
    await router.request(`/games/${SLUG}/package`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprint: changed }),
    });
    const v2 = await (await router.request(`/games/${SLUG}/versions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'second cut' }),
    })).json();
    expect(v2.tag).toBe('v2');
  });

  test('current reflects the latest tag', async () => {
    const cur = await (await router.request(`/games/${SLUG}/versions/current`)).json();
    expect(cur.tag).toBe('v2');
    expect(typeof cur.commitHash).toBe('string');
    expect(cur.dirty).toBe(false);
  });

  test('runtime state (sessions/, logs) is kept out of the version', async () => {
    const { writeFile, mkdir } = await import('fs/promises');
    const { execFileSync } = await import('node:child_process');
    // simulate agent runtime state landing in the game dir
    await mkdir(resolve(gameRoot(), 'sessions', 'abc', 'logs'), { recursive: true });
    await writeFile(resolve(gameRoot(), 'sessions', 'abc', 'session.json'), '{}');
    await writeFile(resolve(gameRoot(), 'sessions', 'abc', 'logs', 'debug.log'), 'noise');
    await writeFile(resolve(gameRoot(), 'run.log'), 'noise');
    // change blueprint so a new version is actually created
    await router.request(`/games/${SLUG}/package`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ blueprint: { ...sampleBlueprint, graph: { nodes: [{ id: 'z' }], edges: [] } } }),
    });
    await router.request(`/games/${SLUG}/versions`, { method: 'POST' });

    // .gitignore was created with the defaults
    const gi = await (await import('fs/promises')).readFile(resolve(gameRoot(), '.gitignore'), 'utf-8');
    expect(gi).toContain('sessions/');
    expect(gi).toContain('*.log');

    // sessions/ + *.log are NOT tracked in the committed version
    const tracked = execFileSync('git', ['-C', gameRoot(), 'ls-tree', '-r', '--name-only', 'HEAD'], { encoding: 'utf-8' });
    expect(tracked).not.toContain('sessions/');
    expect(tracked).not.toContain('run.log');
    expect(tracked).toContain('blueprint.json');
  });
});

describe('GET /games/:slug/components/*', () => {
  test('404 when dist/components is unbuilt (client falls back to built-ins)', async () => {
    const res = await router.request(`/games/${SLUG}/components/index.js`);
    expect(res.status).toBe(404);
  });

  test('serves a built component artifact with js content-type', async () => {
    const compDir = resolve(gameRoot(), 'dist', 'components');
    await mkdir(compDir, { recursive: true });
    const { writeFile } = await import('fs/promises');
    await writeFile(resolve(compDir, 'index.js'), 'export function register(){}');
    const res = await router.request(`/games/${SLUG}/components/index.js`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/javascript');
    expect(await res.text()).toContain('register');
  });

  test('rejects path traversal', async () => {
    const res = await router.request(`/games/${SLUG}/components/../../project.json`);
    expect(res.status === 404 || res.status === 400).toBe(true);
  });
});
