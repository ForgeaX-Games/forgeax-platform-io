// game-host.ts — /api/game-host router (game package persistence + versioning).
//
// The generic "game host" capability: every game is an independent git repo at
// `.forgeax/games/<slug>/`; the extension (video-game, …) reads/writes its
// package over HTTP and tags versions, instead of running its own dev-server
// write path. SSOT:
//   docs/superpowers/specs/2026-07-22-game-host-api-design.md
//   packages/marketplace/extensions/video-game/docs/.../2026-07-22-game-package-storage-design.md
//
//   GET  /games/:slug/package           → { project, blueprint, assetsManifest }
//   PUT  /games/:slug/package           → write 3 files in one transaction
//   POST /games/:slug/versions          → git commit + annotated tag vN
//   GET  /games/:slug/versions/current  → { tag, commitHash, dirty }
//
// checkout / rollback stay internal (game-git) and are intentionally NOT routed.

import { Hono, type Context } from 'hono';
import { existsSync, statSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defaultProjectRoot, resolveSafePath } from './lib/safe-path';
import {
  GamePackageValidationError,
  readGamePackage,
  writeGamePackage,
  classifyGamePackage,
  initializeGamePackage,
} from './lib/game-package';
import { createVersion, currentVersion, listVersions, readPackageAtTag } from './lib/game-git';
import { Hono as ScopedHono } from 'hono';
import { inspectRepositoryRoot } from '../version-control/root';
import { buildVersionGraph, listTagRefs } from '../version-control/graph';
import { initializeRepository } from '../version-control/init';
import { readRepositorySnapshot } from '../version-control/status';
import { publishVersion } from '../version-control/publish';
import { checkoutDetached } from '../version-control/checkout';
import { resolveGitExecutable, validateGitExecutable } from '../version-control/executable';
import { loadGitSettings, saveGitSettings } from '../version-control/settings';
import { CommandError } from '../version-control/errors';

// Same slug shape video-game uses; also blocks path traversal via slug.
const SLUG_RE = /^[a-z0-9][a-z0-9-]{0,40}$/;

export type VersionControlPayloadResult = { ok: true; value: Record<string, unknown> } | { ok: false; code: 'invalid-payload'; field?: string };

export function validateVersionControlPayload(payload: unknown): VersionControlPayloadResult {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return { ok: false, code: 'invalid-payload' };
  const value = payload as Record<string, unknown>;
  if ('cwd' in value || 'argv' in value || 'executable' in value || 'gameRoot' in value) return { ok: false, code: 'invalid-payload' };
  const allowed = new Set(['candidatePath', 'tag', 'message', 'expectedSnapshotId', 'expectedCommit', 'requestId']);
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown) return { ok: false, code: 'invalid-payload', field: unknown };
  return { ok: true, value };
}

export function resolveGameVersionControlRoot(authorityRoot: string, requestedRoot: string): string {
  const authority = resolve(authorityRoot);
  const requested = resolve(requestedRoot);
  if (requested !== authority) throw new TypeError('Version-control root is outside the current game authority');
  return authority;
}

export function createVersionControlRouter(options: { gameRoot: string }) {
  const router = new ScopedHono();
  const authorityRoot = resolve(options.gameRoot);

  const asError = (code: string, stage: string, hint: string, cause?: unknown): CommandError => new CommandError({
    code,
    stage,
    hint,
    cause: cause === undefined ? undefined : String(cause).slice(0, 512),
    recoveryActions: ['version-control.refresh'],
  });

  const readSnapshotModel = async () => {
    const inspected = await inspectRepositoryRoot(authorityRoot);
    if (!inspected.ok) return { status: 'uninitialized' as const, error: asError('version-control-unavailable', 'snapshot', 'Initialize the current game repository') };
    const snapshot = await readRepositorySnapshot(authorityRoot);
    if (!snapshot.ok) return { status: 'faulted' as const, error: asError(snapshot.code, 'snapshot', 'Refresh repository status', snapshot.cause) };
    try {
      const [graph, refs] = await Promise.all([buildVersionGraph(authorityRoot), listTagRefs(authorityRoot)]);
      const currentTag = refs.find((ref) => ref.commit === snapshot.head)?.tag ?? null;
      return {
        status: 'ready' as const,
        repositoryIdentity: snapshot.repositoryIdentity,
        head: snapshot.head,
        currentTag,
        snapshotId: snapshot.snapshotId,
        dirtyRecords: snapshot.records.map((record) => ({
          path: record.path,
          kind: record.kind,
          ...(record.oldPath === undefined ? {} : { oldPath: record.oldPath }),
        })),
        graph: {
          nodes: graph.nodes.map((node) => ({
            id: node.commit,
            head: node.commit,
            message: node.message,
            committedAt: node.committedAt,
            tags: node.tags,
            ...(node.tags[0] === undefined ? {} : { tag: node.tags[0] }),
            ...(node.latest ? { latest: true } : {}),
          })),
          edges: graph.edges,
        },
      };
    } catch (error) {
      return { status: 'faulted' as const, error: asError('version-control-command-failed', 'graph', 'Refresh the version graph', error) };
    }
  };

  router.get('/snapshot', async (c) => {
    const model = await readSnapshotModel();
    // An uninitialized repository is a valid projection that the UI can offer
    // to initialize; reserve 503 for an actual provider failure.
    return model.status === 'ready' || model.status === 'uninitialized'
      ? c.json(model, 200)
      : c.json(model, 503);
  });

  const requiredString = (value: Record<string, unknown>, key: string): string | null => typeof value[key] === 'string' && value[key] ? value[key] as string : null;
  const canonicalOperation = (operation: string): string => ({
    configure: 'configureGitExecutable',
    initialize: 'initializeGameRepository',
    init: 'initializeGameRepository',
    publish: 'publishGameVersion',
    switch: 'switchGameVersion',
  }[operation] ?? operation);
  const operationPayload = (operation: string, value: Record<string, unknown>): { ok: true } | { ok: false; error: CommandError } => {
    const requestId = requiredString(value, 'requestId');
    if (operation === 'status' || operation === 'graph') return Object.keys(value).length === 0 ? { ok: true } : { ok: false, error: asError('version-control-command-failed', 'validate-payload', 'Read operations do not accept a payload') };
    if (!requestId) return { ok: false, error: asError('version-control-command-failed', 'validate-payload', 'Every version-control command requires requestId') };
    if (operation === 'configureGitExecutable' && value.candidatePath !== undefined && !requiredString(value, 'candidatePath')) return { ok: false, error: asError('version-control-command-failed', 'validate-payload', 'Configure Git candidatePath must be a non-empty string') };
    if (operation === 'publishGameVersion' && (!requiredString(value, 'tag') || !requiredString(value, 'expectedSnapshotId'))) return { ok: false, error: asError('version-control-command-failed', 'validate-payload', 'Publish requires tag and expectedSnapshotId') };
    if (operation === 'switchGameVersion' && (!requiredString(value, 'tag') || !requiredString(value, 'expectedCommit'))) return { ok: false, error: asError('version-control-command-failed', 'validate-payload', 'Switch requires tag and expectedCommit') };
    if (operation !== 'configureGitExecutable' && operation !== 'initializeGameRepository' && operation !== 'publishGameVersion' && operation !== 'switchGameVersion' && operation !== 'status' && operation !== 'graph') return { ok: false, error: asError('version-control-command-failed', 'validate-operation', 'Unknown version-control operation') };
    return { ok: true };
  };

  const jsonError = (c: Context, error: CommandError, status = 409) => c.json({ ok: false, error: error.toJSON() }, status as never);
  router.post('/commands/:operation', async (c) => {
    let payload: unknown;
    try { payload = await c.req.json(); } catch { return c.json({ code: 'invalid-payload' }, 400); }
    const valid = validateVersionControlPayload(payload);
    if (!valid.ok) return c.json(valid, 400);
    const operation = canonicalOperation(c.req.param('operation'));
    const checked = operationPayload(operation, valid.value);
    if (!checked.ok) return jsonError(c, checked.error, 400);
    const value = valid.value;
    const root = await inspectRepositoryRoot(authorityRoot);
    if (operation === 'status' || operation === 'graph') {
      const model = await readSnapshotModel();
      return model.status === 'ready' ? c.json({ ok: true, value: model }, 200) : jsonError(c, model.error, 503);
    }
    if (operation === 'configureGitExecutable') {
      const candidate = requiredString(value, 'candidatePath')
        ? await validateGitExecutable(value.candidatePath as string)
        : await resolveGitExecutable({ persist: true });
      if (!candidate.ok) return jsonError(c, asError('version-control-unavailable', 'configure-git', 'Select an executable Git binary', candidate.cause), 503);
      saveGitSettings({ ...loadGitSettings(), gitExecutablePath: candidate.path });
      return c.json({ ok: true, value: { path: candidate.path, source: candidate.source, version: candidate.version, requestId: value.requestId } }, 200);
    }
    if (operation === 'initializeGameRepository') {
      try {
        const valueResult = await initializeRepository(authorityRoot);
        return c.json({ ok: true, value: { ...valueResult, requestId: value.requestId } }, 200);
      } catch (error) { return jsonError(c, asError('version-control-command-failed', 'initialize', 'Initialize the current game repository', error), 500); }
    }
    if (!root.ok) return jsonError(c, asError('version-control-unavailable', 'command', 'Initialize the current game repository'), 503);
    if (operation === 'publishGameVersion') {
      const result = await publishVersion(authorityRoot, { tag: value.tag as string, message: (value.message as string | undefined) ?? '', expectedSnapshotId: value.expectedSnapshotId as string, requestId: value.requestId as string });
      return result.ok ? c.json({ ok: true, value: result }, 200) : jsonError(c, result.error, 409);
    }
    const result = await checkoutDetached(authorityRoot, { tag: value.tag as string, expectedCommit: value.expectedCommit as string, requestId: value.requestId as string });
    return result.ok ? c.json({ ok: true, value: result.receipt }, 200) : jsonError(c, result.error, 409);
  });
  return router;
}

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
 * artifacts (e.g. video-game copies its component set into the game dir) that
 * should travel with the version. game-host stays generic — it just invokes the
 * hook and never knows what it does.
 */
export interface GameHostOptions {
  beforeVersion?: (args: { slug: string; gameDir: string; project: unknown }) => void | Promise<void>;
  seedProvider?: (args: { slug: string }) => Promise<{
    project?: unknown;
    blueprint: unknown;
    assetsManifest: unknown;
  }>;
}

type InitResult = { status: number; body: unknown };
const initFlights = new Map<string, Promise<InitResult>>();

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

  const createPreparedVersion = async (slug: string, dir: string, message?: string) => {
    if (opts.beforeVersion) {
      const project = readGamePackage(dir).project;
      await opts.beforeVersion({ slug, gameDir: dir, project });
    }
      return createVersion(dir, message);
  };

  r.get('/games/:slug/package', (c) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    return c.json(readGamePackage(dir));
  });

  const packageStatus = (c: any) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ state: 'inconsistent', missing: [], error: { code: 'video-game-invalid-slug', target: 'slug', retryable: false } }, 400);
    return c.json(classifyGamePackage(dir));
  };
  r.get('/games/:slug/package/status', packageStatus);

  const initialize = async (c: any) => {
    const slug = c.req.param('slug');
    const dir = gameDir(slug);
    if (!dir) return c.json({ state: 'error', error: { code: 'video-game-invalid-slug', target: 'slug', retryable: false } }, 400);
    const seedProvider = opts.seedProvider;
    if (!seedProvider) return c.json({ state: 'error', error: { code: 'video-game-seed-not-found', target: 'seedProvider', hint: 'Install the canonical sample and retry', retryable: true } }, 503);
    const existing = initFlights.get(slug);
    if (existing) {
      const result = await existing;
      return c.json(result.body, result.status);
    }
    const flight = (async () => {
      const current = classifyGamePackage(dir);
      if (current.state === 'inconsistent') {
        return { status: 409, body: { ...current, initialized: false, error: { code: 'video-game-package-inconsistent', target: current.missing.join(',') || 'package', retryable: false } } };
      }
      try {
        if (current.state === 'initialized') {
          const existingVersion = await currentVersion(dir);
          const version = existingVersion.tag
            ? existingVersion
            : await createPreparedVersion(slug, dir, '[game-host] Initial video game version');
          return { status: 200, body: { ...current, initialized: false, version } };
        }
        const seed = await seedProvider({ slug });
        initializeGamePackage(dir, slug, seed);
        const version = await createPreparedVersion(slug, dir, '[game-host] Initial video game version');
        return { status: 200, body: { ...classifyGamePackage(dir), initialized: true, version } };
      } catch (error) {
        return { status: 500, body: { state: 'error', initialized: false, error: { code: 'video-game-initialization-failed', target: 'package', hint: String((error as Error)?.message ?? error), retryable: true } } };
      }
    })();
    initFlights.set(slug, flight);
    try {
      const result = await flight;
      return c.json(result.body, result.status);
    } finally { initFlights.delete(slug); }
  };
  r.post('/games/:slug/package/initialize', initialize);
  r.post('/games/:slug/initialize', initialize);

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
      const status = e instanceof GamePackageValidationError ? 400 : 500;
      return c.json({ error: String((e as Error)?.message ?? e) }, status);
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
      return c.json(await createPreparedVersion(slug, dir, message));
    } catch (e) {
      return c.json({ error: String((e as Error)?.message ?? e) }, 500);
    }
  });

  r.get('/games/:slug/versions/current', async (c) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    return c.json(await currentVersion(dir));
  });

  // List all versions (newest first) — for a non-destructive "switch version" UI.
  r.get('/games/:slug/versions', async (c) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    return c.json({ versions: await listVersions(dir) });
  });

  // Read a package AT a version tag (read-only, no checkout / no history rewrite).
  // The editor loads this into its working set; saving creates a new version.
  r.get('/games/:slug/versions/:tag/package', async (c) => {
    const dir = gameDir(c.req.param('slug'));
    if (!dir) return c.json({ error: 'invalid slug' }, 400);
    const pkg = await readPackageAtTag(dir, c.req.param('tag'));
    if (!pkg) return c.json({ error: 'version not found' }, 404);
    return c.json(pkg);
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
