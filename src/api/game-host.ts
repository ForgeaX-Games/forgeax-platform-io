// game-host.ts — /api/game-host router (game package persistence + versioning).
//
// The generic "game host" capability: every game is an independent git repo at
// `.forgeax/games/<slug>/`; the extension (wb-game-video, …) reads/writes its
// package over HTTP and tags versions, instead of running its own dev-server
// write path. SSOT:
//   docs/superpowers/specs/2026-07-22-game-host-api-design.md
//   packages/marketplace/extensions/wb-game-video/docs/.../2026-07-22-game-package-storage-design.md
//
//   GET  /games/:slug/package           → { project, blueprint, assetsManifest }
//   PUT  /games/:slug/package           → write 3 files in one transaction
//   POST /games/:slug/versions          → git commit + annotated tag vN
//   GET  /games/:slug/versions/current  → { tag, commitHash, dirty }
//
// checkout / rollback stay internal (game-git) and are intentionally NOT routed.

import { Hono } from 'hono';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultProjectRoot, resolveSafePath } from './lib/safe-path';
import { readGamePackage, writeGamePackage } from './lib/game-package';
import { createVersion, currentVersion } from './lib/game-git';

// Same slug shape wb-game-video uses; also blocks path traversal via slug.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,40}$/;

/** Resolve `.forgeax/games/<slug>` through the safe-path whitelist. */
function gameDir(slug: string): string | null {
  if (!SLUG_RE.test(slug)) return null;
  return resolveSafePath(defaultProjectRoot(), `.forgeax/games/${slug}`);
}

// Minimal content-type map for served component build artifacts.
const MIME: Record<string, string> = {
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
};

/**
 * Optional per-version prepare hook (injected by the product shell). Runs
 * server-side right before `git add -A`, so it can top up platform-contributed
 * artifacts (e.g. wb-game-video copies its component set into the game dir) that
 * should travel with the version. game-host stays generic — it just invokes the
 * hook and never knows what it does.
 */
export interface GameHostOptions {
  beforeVersion?: (args: { slug: string; gameDir: string; project: unknown }) => void | Promise<void>;
}

/** Confine a `dist/components/<rel>` request under the game dir (no traversal). */
function componentFile(slug: string, rel: string): string | null {
  const dir = gameDir(slug);
  if (!dir) return null;
  const clean = rel.replace(/^\/+/, '');
  if (clean.includes('..') || clean.includes('\0')) return null;
  const abs = resolve(dir, 'dist', 'components', clean || 'index.js');
  // Stay inside dist/components.
  const base = resolve(dir, 'dist', 'components');
  if (abs !== base && !abs.startsWith(base + '/')) return null;
  return abs;
}

export function createGameHostRouter(opts: GameHostOptions = {}) {
  const r = new Hono();

  r.get('/games/:slug/package', (c) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    return c.json(readGamePackage(dir));
  });

  r.put('/games/:slug/package', async (c) => {
    const slug = c.req.param('slug');
    const dir = gameDir(slug);
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    let body: { project?: unknown; blueprint?: unknown; assetsManifest?: unknown };
    try {
      body = (await c.req.json()) as typeof body;
    } catch {
      return c.json({ error: 'invalid json' }, 400);
    }
    if (body?.blueprint == null) return c.json({ error: 'missing blueprint' }, 400);
    try {
      writeGamePackage(dir, slug, {
        project: body.project,
        blueprint: body.blueprint,
        assetsManifest: body.assetsManifest,
      });
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 500);
    }
    return c.json({ ok: true });
  });

  r.post('/games/:slug/versions', async (c) => {
    const slug = c.req.param('slug');
    const dir = gameDir(slug);
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    let message: string | undefined;
    try {
      const b = (await c.req.json()) as { message?: unknown };
      if (typeof b?.message === 'string') message = b.message;
    } catch {
      /* body is optional */
    }
    try {
      // Version-prepare hook (e.g. sync platform components into the game dir)
      // runs before git add -A so the snapshot includes it.
      if (opts.beforeVersion) {
        const project = readGamePackage(dir).project;
        await opts.beforeVersion({ slug, gameDir: dir, project });
      }
      return c.json(createVersion(dir, message));
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  });

  r.get('/games/:slug/versions/current', (c) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    return c.json(currentVersion(dir));
  });

  // Serve a game's built component artifacts (dist/components/*) so the runtime
  // component-host can load per-game components. 404 when unbuilt/missing —
  // the client falls back to the platform built-in set.
  r.get('/games/:slug/components/*', (c) => {
    const slug = c.req.param('slug');
    if (!SLUG_RE.test(slug)) return c.json({ error: 'invalid slug' }, 400);
    const rel = c.req.path.split(`/games/${slug}/components/`)[1] ?? '';
    const abs = componentFile(slug, rel);
    if (!abs || !existsSync(abs) || !statSync(abs).isFile()) {
      return c.json({ error: 'not found' }, 404);
    }
    const ext = abs.split('.').pop()?.toLowerCase() ?? '';
    const body = readFileSync(abs);
    return c.body(body, 200, {
      'content-type': MIME[ext] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
  });

  return r;
}
