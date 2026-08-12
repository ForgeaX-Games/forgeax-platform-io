import { realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface ForgeaxGameProjection {
  /** Stable user-facing path under the Studio instance. */
  readonly gameRoot: string;
  /** Canonical directory on which scoped IO authority must be anchored. */
  readonly authorityRoot: string;
  readonly kind: 'instance' | 'package';
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
 * Workbench IO authority: a direct `.forgeax/games` child or a same-name
 * projection of `packages/games/<gameId>`.
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
    const packageGamesRoot = realpathSync(resolve(projectRoot, 'packages', 'games'));
    if (relative(packageGamesRoot, authorityRoot) === gameId) {
      return { gameRoot, authorityRoot, kind: 'package' };
    }
  } catch {
    return undefined;
  }
  return undefined;
}
