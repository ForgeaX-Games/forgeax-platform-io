import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { loadKnownGames } from '../api/lib/known-games';

export interface ForgeaxGameProjection {
  /** Stable user-facing path under the Studio instance. */
  readonly gameRoot: string;
  /** Canonical directory on which scoped IO authority must be anchored. */
  readonly authorityRoot: string;
  readonly kind: 'instance' | 'package' | 'external';
}

function directChild(parent: string, child: string): boolean {
  const fromParent = relative(parent, child);
  return Boolean(fromParent)
    && fromParent !== '..'
    && !fromParent.startsWith(`..${sep}`)
    && !isAbsolute(fromParent)
    && !fromParent.includes(sep);
}

/**
 * Resolve the one supported game layout shared by the launcher, server and
 * Extension IO authority: a direct `.forgeax/games` child, a same-name
 * projection of `packages/games/<gameId>`, or an explicitly opened external
 * game recorded in known-games.json.
 */
export function resolveForgeaxGameProjection(
  projectRoot: string,
  gameId: string,
): ForgeaxGameProjection | undefined {
  const gamesRoot = resolve(projectRoot, '.forgeax', 'games');
  const gameRoot = resolve(gamesRoot, gameId);
  if (relative(gamesRoot, gameRoot) !== gameId) return undefined;
  try {
    if (!statSync(gameRoot).isDirectory()) return undefined;
    const authorityRoot = realpathSync(gameRoot);
    if (directChild(realpathSync(gamesRoot), authorityRoot)) {
      return { gameRoot, authorityRoot, kind: 'instance' };
    }
    try {
      const packageGamesRoot = realpathSync(resolve(projectRoot, 'packages', 'games'));
      if (relative(packageGamesRoot, authorityRoot) === gameId) {
        return { gameRoot, authorityRoot, kind: 'package' };
      }
    } catch {
      // The optional forgeax-games floating checkout is commonly absent.
    }

    // `/api/extension/games/link` intentionally accepts consumer-owned games
    // outside Studio's optional packages/games checkout (for example the
    // editor-owned `packages/editor/games/sample`). The link is the explicit
    // authority grant; do not accept arbitrary symlinks merely because they
    // happen to sit below .forgeax/games.
    const known = loadKnownGames().some((entry) => {
      if (entry.slug !== undefined && entry.slug !== gameId) return false;
      try {
        return realpathSync(resolve(entry.path)) === authorityRoot;
      } catch {
        return false;
      }
    });
    if (known) return { gameRoot, authorityRoot, kind: 'external' };
  } catch {
    return undefined;
  }
  return undefined;
}
