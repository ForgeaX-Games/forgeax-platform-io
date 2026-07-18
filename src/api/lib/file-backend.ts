// file-backend.ts — the confinement seam for createFilesRouter (R6→R3).
//
// WHY THIS EXISTS (ideal-clean-architecture.md §5 "复用,不另写后端" + §1 SSOT):
//   The /api/files wire contract (GET/POST/DELETE { path, content } + /raw +
//   /tree) is ONE backend. But WHERE those paths resolve on disk has two shapes:
//
//     - studio (cli 后L2 / server 后L3): root = FORGEAX_PROJECT_ROOT, whitelist
//       games/** · packages/** · .forgeax/{games,user} — the multi-project host.
//     - editor standalone (前L2): ONE game opened at an arbitrary `--game <dir>`,
//       addressed by a client-space `<slug>/<rel>` pointer, confined to that dir.
//
//   Before R3 the editor shipped a SECOND, hand-written read-only file backend in
//   its vite middleware (a §5 violation: "为启动自写一个独立后端"). This seam lets
//   the editor REUSE this very router by injecting a different path resolver —
//   one wire contract, two confinement strategies, zero duplicated tree-walk /
//   read / write logic.
//
// FAIL FAST (§5): a resolver returns null for any path outside its confinement;
// the route maps null → 400. resolveRead may exist-probe (studio packages/**
// asset-root fallback); resolveWrite never does.

import { resolve, dirname, basename, sep } from 'node:path';
import { existsSync } from 'node:fs';
import { defaultProjectRoot, resolveSafePath, ALLOWED_TOP_DIRS } from './safe-path';
import { assetRoot } from '../../lib/asset-root';
import { listTree, type TreeNode } from './io';

/** Shared 400 body — kept identical to the pre-R3 studio handler for byte parity. */
export const WHITELIST_ERROR = 'path outside whitelist (games/** or packages/**)';

export type TreeResult =
  | { ok: true; tree: TreeNode }
  | { ok: false; status: 400 | 404; error: string };

export interface FileBackend {
  /** Resolve a client path to an absolute disk path for READ (GET / and /raw),
   *  or null if outside confinement. May return a non-existent path (the route's
   *  readFileSafe then yields 404). */
  resolveRead(rel: string): string | null;
  /** Resolve a client path to an absolute disk path for WRITE/DELETE (POST /,
   *  /upload, DELETE /), or null if outside confinement. */
  resolveWrite(rel: string): string | null;
  /** Build the file tree for a client-space `root` query (''=the backend's top). */
  tree(rel: string): Promise<TreeResult>;
}

/**
 * Studio backend — byte-for-byte the pre-R3 createFilesRouter behavior.
 * Root = FORGEAX_PROJECT_ROOT (read lazily per call, as before); whitelist via
 * resolveSafePath; packages/** missing-read redirect to assetRoot() (packaged
 * .app reads host-bundled assets).
 */
export function studioFileBackend(): FileBackend {
  return {
    resolveRead(rel) {
      const root = defaultProjectRoot();
      const abs = resolveSafePath(root, rel);
      // packages/** are host-bundled read-only assets; in the packaged .app they
      // live under assetRoot(), not the writable project root. Redirect a missing
      // packages/** read there (dev: assetRoot() === packages/, so it's a no-op).
      if (abs && !existsSync(abs) && rel.startsWith('packages/')) {
        const alt = resolve(assetRoot(), rel.slice('packages/'.length));
        if (existsSync(alt)) return alt;
      }
      return abs;
    },
    resolveWrite(rel) {
      return resolveSafePath(defaultProjectRoot(), rel);
    },
    async tree(rel) {
      const root = defaultProjectRoot();
      if (!rel) {
        const children: TreeNode[] = [];
        for (const top of ALLOWED_TOP_DIRS) {
          const sub = await listTree(root, top, 4);
          if (sub) children.push(sub);
        }
        return { ok: true, tree: { name: '.', path: '', type: 'dir', children } };
      }
      const abs = resolveSafePath(root, rel);
      if (!abs) return { ok: false, status: 400, error: WHITELIST_ERROR };
      const tree = await listTree(root, rel, 4);
      if (!tree) return { ok: false, status: 404, error: 'not found' };
      return { ok: true, tree };
    },
  };
}

/**
 * Single-game backend — for the standalone editor (R3). Opens ONE game directory
 * addressed by a client-space `<slug>/<rel>` pointer (slug = basename(dir)), the
 * exact wire paths editor-core already produces via resolveGamePath. All access
 * is confined to `dir`; a path not addressing this game, or escaping it, → null.
 *
 * The tree walk reuses listTree(parentOfDir, slug) unchanged, so node paths come
 * out in client space (`<slug>/…`) with the SAME depth-4 / skip-name semantics
 * the embedded studio editor sees — one tree contract, not a second walker.
 */
export function singleGameFileBackend(gameDir: string): FileBackend {
  const dir = resolve(gameDir);
  const slug = basename(dir);
  const parent = dirname(dir);
  const dirWithSep = dir.endsWith(sep) ? dir : dir + sep;

  // Map a client path (`<slug>` | `<slug>/<rel>`) → abs under dir, or null.
  const toDisk = (clientPath: string | null): string | null => {
    if (clientPath === null || clientPath === '') return null;
    if (clientPath.includes('\0')) return null;
    let rel: string;
    if (clientPath === slug) rel = '';
    else if (clientPath.startsWith(`${slug}/`)) rel = clientPath.slice(slug.length + 1);
    else return null; // not addressing this game
    const abs = resolve(dir, rel);
    if (abs !== dir && !abs.startsWith(dirWithSep)) return null; // traversal escape
    return abs;
  };

  return {
    resolveRead: toDisk,
    resolveWrite: toDisk,
    async tree(rel) {
      // '' → whole game; otherwise must address this game's subtree.
      const r = rel === '' ? slug : rel;
      if (r !== slug && !r.startsWith(`${slug}/`)) {
        return { ok: false, status: 400, error: WHITELIST_ERROR };
      }
      // listTree(parent, '<slug>/…') reads under dir and yields client-space paths.
      const tree = await listTree(parent, r, 4);
      if (!tree) return { ok: false, status: 404, error: 'not found' };
      return { ok: true, tree };
    },
  };
}
