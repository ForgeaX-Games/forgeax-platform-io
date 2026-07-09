import { describe, test, expect, beforeAll, afterAll } from 'bun:test';
import { mkdtemp, mkdir, rm, stat } from 'fs/promises';
import { tmpdir } from 'node:os';
import { resolve, basename, join } from 'node:path';
import { createFilesRouter } from '../src/api/files';
import { singleGameFileBackend } from '../src/api/lib/file-backend';

// Regression coverage for the "New Folder" bug: POST /api/files with
// `mkdir: true` used to fall through to writeFileSafe and silently create an
// empty *file* named after the intended folder (Content Browser blank-area
// "New Folder" then had nothing to show, since folder listings only surface
// `type: 'dir'` entries).

let tmp: string;
let gameDir: string;
let slug: string;
let router: ReturnType<typeof createFilesRouter>;

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), 'fx-files-router-'));
  gameDir = resolve(tmp, 'my-game');
  slug = basename(gameDir);
  await mkdir(resolve(gameDir, 'assets'), { recursive: true });
  router = createFilesRouter(singleGameFileBackend(gameDir));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe('POST /api/files — mkdir branch', () => {
  test('{ mkdir: true } creates a real directory, not an empty file', async () => {
    const target = `${slug}/assets/NewFolder`;
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target, content: '', mkdir: true }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ path: target, directory: true });

    const s = await stat(resolve(gameDir, 'assets', 'NewFolder'));
    expect(s.isDirectory()).toBe(true);
  });

  test('{ mkdir: true } is idempotent (recursive: true, no error on re-create)', async () => {
    const target = `${slug}/assets/NewFolder`;
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target, content: '', mkdir: true }),
    });
    expect(res.status).toBe(200);
  });

  test('omitting mkdir still writes a plain file (no regression to normal writes)', async () => {
    const target = `${slug}/assets/note.txt`;
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target, content: 'hello' }),
    });
    expect(res.status).toBe(200);
    const s = await stat(resolve(gameDir, 'assets', 'note.txt'));
    expect(s.isFile()).toBe(true);
  });

  test('missing content when mkdir is absent → 400', async () => {
    const target = `${slug}/assets/bad.txt`;
    const res = await router.request('/', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: target }),
    });
    expect(res.status).toBe(400);
  });
});
