import { Hono } from 'hono';
import { stat, unlink } from 'fs/promises';
import { readFileSafe, writeFileSafe, classify } from './lib/io';
import { type FileBackend, studioFileBackend, WHITELIST_ERROR } from './lib/file-backend';

interface WriteBody {
  path?: unknown;
  content?: unknown;
}

/**
 * /api/files router. WHERE paths resolve is injected via `backend` (file-backend.ts):
 *   - no arg → studioFileBackend(): byte-identical to the pre-R3 router
 *     (FORGEAX_PROJECT_ROOT + games/**·packages/** whitelist). cli/server use this.
 *   - singleGameFileBackend(dir): the standalone editor (R3) confines to one game.
 * The wire contract (GET/POST/DELETE /, /upload, /raw, /tree) is identical for both.
 */
export function createFilesRouter(backend: FileBackend = studioFileBackend()) {
  const r = new Hono();

  r.get('/', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = backend.resolveRead(rel);
    if (!abs) return c.json({ error: WHITELIST_ERROR }, 400);
    try {
      const info = await readFileSafe(abs, rel);
      return c.json(info);
    } catch (e) {
      const msg = (e as Error).message;
      // Differentiate dir-vs-missing: tick 351 found the bare GET on a
      // directory returned 404 "not found", masking the fact that the
      // path WAS valid — just the wrong endpoint shape.
      if (msg.startsWith('is a directory')) {
        return c.json({ error: msg }, 400);
      }
      // `optional=1`: the caller probes a file that legitimately may not exist
      // (per-developer launcher state like play-config.json). Return 200
      // { exists:false } so the browser's network panel logs no red 404 for an
      // expected-absent file. 404 stays the default for genuine missing-file
      // errors every other caller relies on. Ported from server hotfix cae7495.
      if (c.req.query('optional') === '1') {
        return c.json({ exists: false, content: null });
      }
      return c.json({ error: 'not found' }, 404);
    }
  });

  r.post('/', async (c) => {
    let body: WriteBody;
    try {
      body = (await c.req.json()) as WriteBody;
    } catch {
      return c.json({ error: 'invalid json body' }, 400);
    }
    if (typeof body?.path !== 'string' || typeof body?.content !== 'string') {
      return c.json({ error: 'fields { path: string, content: string } required' }, 400);
    }
    const abs = backend.resolveWrite(body.path);
    if (!abs) return c.json({ error: WHITELIST_ERROR }, 400);
    try {
      const { bytes } = await writeFileSafe(abs, body.content);
      return c.json({ path: body.path, bytes });
    } catch (e) {
      const msg = (e as Error).message;
      // Same pattern as the GET handler — dir target gets a structured
      // 400 instead of a noisy 500 with raw EISDIR text.
      if (msg.startsWith('target path is a directory')) {
        return c.json({ error: msg }, 400);
      }
      return c.json({ error: msg }, 500);
    }
  });

  // POST /api/files/upload — write a binary asset to the project (games/**).
  // Body: { path: string, data: string (base64) }
  // The editor's "Import Asset" feature uses this for GLB, PNG, etc. — the
  // string POST /api/files endpoint doesn't handle binary (mojibake risk).
  r.post('/upload', async (c) => {
    let body: { path?: unknown; data?: unknown };
    try { body = await c.req.json() as { path?: unknown; data?: unknown }; }
    catch { return c.json({ error: 'invalid json body' }, 400); }
    if (typeof body?.path !== 'string' || typeof body?.data !== 'string') {
      return c.json({ error: 'fields { path: string, data: string (base64) } required' }, 400);
    }
    const abs = backend.resolveWrite(body.path);
    if (!abs) return c.json({ error: WHITELIST_ERROR }, 400);
    try {
      const buf = Buffer.from(body.data, 'base64');
      await Bun.write(abs, buf);
      return c.json({ path: body.path, bytes: buf.byteLength });
    } catch (e) {
      return c.json({ error: (e as Error).message }, 500);
    }
  });

  // GET /api/files/raw?path=<rel> — stream the file bytes with a proper
  // Content-Type so <img>/<audio>/<video>/<model-viewer> can consume it
  // directly. The JSON /api/files route deliberately stops returning bytes
  // for binary kinds (PNG/GLB/MP3/etc were being force-decoded into mojibake);
  // this is the companion endpoint that hands those bytes back unmangled.
  // Whitelist is the same as the JSON route via the backend resolver.
  r.get('/raw', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = backend.resolveRead(rel);
    if (!abs) return c.json({ error: WHITELIST_ERROR }, 400);
    let s;
    try {
      s = await stat(abs);
    } catch {
      return c.json({ error: 'not found' }, 404);
    }
    if (s.isDirectory()) {
      return c.json({ error: 'is a directory — use GET /api/files/tree?root=<path>' }, 400);
    }
    const { mime } = classify(rel);
    const f = Bun.file(abs);
    // 媒体资源 (video/* / image/* / audio/*) 走轻量级缓存: 5 分钟内同 url 切换
    // 直接吃浏览器 disk cache, 不走 HTTP. ADR-0019 头像状态机切 state 时多次拉
    // 同一批 webm, no-cache 会让每次切换都打一次 HTTP → 视觉空白窗.
    // 文本/JSON 等仍 no-cache (热重载/编辑场景需要立即看到新内容).
    const isMedia = mime.startsWith('video/') || mime.startsWith('image/') || mime.startsWith('audio/');
    return new Response(f, {
      headers: {
        'Content-Type': mime,
        'Content-Length': String(s.size),
        'Cache-Control': isMedia ? 'public, max-age=300' : 'no-cache',
      },
    });
  });

  r.get('/tree', async (c) => {
    const rel = c.req.query('root') ?? '';
    const result = await backend.tree(rel);
    if (!result.ok) return c.json({ error: result.error }, result.status);
    return c.json({ tree: result.tree });
  });

  r.delete('/', async (c) => {
    const rel = c.req.query('path') ?? '';
    const abs = backend.resolveWrite(rel);
    if (!abs) return c.json({ error: WHITELIST_ERROR }, 400);
    try {
      await unlink(abs);
      return c.json({ ok: true, path: rel });
    } catch (e) {
      const msg = (e as Error).message;
      if (msg.includes('ENOENT')) return c.json({ ok: true, path: rel });
      return c.json({ error: msg }, 500);
    }
  });

  return r;
}
