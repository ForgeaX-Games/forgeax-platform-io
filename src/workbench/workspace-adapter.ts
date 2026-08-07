import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type {
  GameFileCapability,
  GameVersionCapability,
  OpenGameRootOptions,
  ScopedGameRoot,
  WorkspaceAdapter,
} from '@forgeax/workbench-host/contracts';
import { defaultProjectRoot } from '../api/lib/safe-path';

const GAME_ID = /^[a-z0-9][a-z0-9-]{1,40}$/;
const heldLocks = new AsyncLocalStorage<ReadonlySet<string>>();
const lockTails = new Map<string, Promise<void>>();

export interface ForgeaxWorkspaceAdapterOptions {
  readonly projectRoot?: string;
}

interface RootIdentity {
  readonly path: string;
  readonly realPath: string;
  readonly dev: bigint | number;
  readonly ino: bigint | number;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function notFound(): Error {
  return Object.assign(new Error('Game workspace was not found'), { code: 'ENOENT' });
}

function assertGameId(gameId: string): void {
  if (!GAME_ID.test(gameId)) {
    throw new TypeError('Game id must be a safe ForgeaX slug');
  }
}

function segments(relativePath: string, allowEmpty = false): string[] {
  if (allowEmpty && relativePath === '') return [];
  if (
    relativePath.length === 0 ||
    isAbsolute(relativePath) ||
    relativePath.includes('\\') ||
    relativePath.includes('\0')
  ) {
    throw new TypeError('Game file path must be a bounded relative path');
  }
  const parts = relativePath.split('/');
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new TypeError('Game file path must be a bounded relative path');
  }
  return parts;
}

async function assertDirectory(path: string, label: string): Promise<void> {
  const details = await lstat(path);
  if (details.isSymbolicLink()) throw new TypeError(`${label} must not be a symbolic link`);
  if (!details.isDirectory()) throw new TypeError(`${label} must be a directory`);
}

async function ensureDirectory(path: string, label: string): Promise<void> {
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  await assertDirectory(path, label);
}

async function openRoot(
  gamesRoot: string,
  gameId: string,
  create: boolean,
): Promise<RootIdentity> {
  const forgeaxRoot = resolve(gamesRoot, '..');
  if (create) {
    await ensureDirectory(forgeaxRoot, 'ForgeaX state root');
    await ensureDirectory(gamesRoot, 'Games root');
  } else {
    try {
      await assertDirectory(forgeaxRoot, 'ForgeaX state root');
      await assertDirectory(gamesRoot, 'Games root');
    } catch (error) {
      if (missing(error)) throw notFound();
      throw error;
    }
  }

  const path = resolve(gamesRoot, gameId);
  if (relative(gamesRoot, path) !== gameId) {
    throw new TypeError('Game root is outside the games root');
  }
  if (create) {
    await ensureDirectory(path, 'Game root');
  } else {
    try {
      await assertDirectory(path, 'Game root');
    } catch (error) {
      if (missing(error)) throw notFound();
      throw error;
    }
  }

  const [realGamesRoot, realPath, details] = await Promise.all([
    realpath(gamesRoot),
    realpath(path),
    stat(path, { bigint: true }),
  ]);
  const fromGames = relative(realGamesRoot, realPath);
  if (
    fromGames.length === 0 ||
    isAbsolute(fromGames) ||
    fromGames === '..' ||
    fromGames.startsWith(`..${sep}`)
  ) {
    throw new TypeError('Game root resolves outside the games root');
  }
  return { path, realPath, dev: details.dev, ino: details.ino };
}

async function assertSameRoot(root: RootIdentity): Promise<void> {
  const link = await lstat(root.path);
  if (link.isSymbolicLink()) throw new TypeError('Game root must not be a symbolic link');
  const [real, details] = await Promise.all([
    realpath(root.path),
    stat(root.path, { bigint: true }),
  ]);
  if (real !== root.realPath || details.dev !== root.dev || details.ino !== root.ino) {
    throw new Error('Game root changed during the scoped operation');
  }
}

async function directoryFor(
  root: RootIdentity,
  parts: readonly string[],
  create: boolean,
): Promise<string | null> {
  await assertSameRoot(root);
  let current = root.path;
  for (const part of parts) {
    current = resolve(current, part);
    try {
      await assertDirectory(current, 'Game file parent');
    } catch (error) {
      if (!missing(error)) throw error;
      if (!create) return null;
      await ensureDirectory(current, 'Game file parent');
    }
  }
  return current;
}

async function withKeys<T>(
  root: RootIdentity,
  keys: readonly string[],
  operation: () => Promise<T>,
): Promise<T> {
  const normalized = [...new Set(keys)].sort();
  if (normalized.length === 0 || normalized.some((key) => !key || key.includes('\0'))) {
    throw new TypeError('Workbench lock keys must be non-empty strings');
  }
  const inherited = heldLocks.getStore() ?? new Set<string>();
  const identities = normalized.map((key) => `${root.realPath}\0${key}`);
  const pending = identities.filter((identity) => !inherited.has(identity));
  const releases: Array<() => void> = [];
  try {
    for (const identity of pending) {
      const previous = lockTails.get(identity) ?? Promise.resolve();
      let release!: () => void;
      const tail = new Promise<void>((resolveTail) => { release = resolveTail; });
      const queued = previous.then(() => tail);
      lockTails.set(identity, queued);
      await previous;
      releases.push(() => {
        release();
        if (lockTails.get(identity) === queued) lockTails.delete(identity);
      });
    }
    return await heldLocks.run(new Set([...inherited, ...identities]), operation);
  } finally {
    releases.reverse().forEach((release) => release());
  }
}

function createFiles(root: RootIdentity, active: () => void): GameFileCapability {
  return {
    async list(relativeDirectory): Promise<string[]> {
      active();
      const directory = await directoryFor(root, segments(relativeDirectory, true), false);
      if (!directory) return [];
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => !entry.isSymbolicLink())
        .map((entry) => entry.name)
        .sort();
    },

    async read(relativePath): Promise<Uint8Array | null> {
      active();
      const parts = segments(relativePath);
      const parent = await directoryFor(root, parts.slice(0, -1), false);
      if (!parent) return null;
      let handle;
      try {
        handle = await open(resolve(parent, parts.at(-1)!), constants.O_RDONLY | constants.O_NOFOLLOW);
      } catch (error) {
        if (missing(error)) return null;
        throw error;
      }
      try {
        if (!(await handle.stat()).isFile()) throw new TypeError('Game path must reference a file');
        return new Uint8Array(await handle.readFile());
      } finally {
        await handle.close();
      }
    },

    async write(relativePath, contents): Promise<void> {
      active();
      const parts = segments(relativePath);
      const parent = await directoryFor(root, parts.slice(0, -1), true);
      if (!parent) throw notFound();
      const name = parts.at(-1)!;
      const temporary = resolve(parent, `.${name}.${randomUUID()}.tmp`);
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      let moved = false;
      try {
        await handle.writeFile(contents);
        await handle.sync();
        await handle.close();
        await rename(temporary, resolve(parent, name));
        moved = true;
        const directory = await open(parent, constants.O_RDONLY);
        try {
          await directory.sync();
        } finally {
          await directory.close();
        }
      } finally {
        await handle.close().catch(() => undefined);
        if (!moved) await unlink(temporary).catch(() => undefined);
      }
    },

    async delete(relativePath): Promise<void> {
      active();
      const parts = segments(relativePath);
      const parent = await directoryFor(root, parts.slice(0, -1), false);
      if (!parent) return;
      const path = resolve(parent, parts.at(-1)!);
      try {
        const details = await lstat(path);
        if (details.isSymbolicLink()) throw new TypeError('Game file must not be a symbolic link');
        await unlink(path);
      } catch (error) {
        if (!missing(error)) throw error;
      }
    },

    withLocks<T>(keys: readonly string[], operation: () => Promise<T>): Promise<T> {
      active();
      return withKeys(root, keys, operation);
    },
  };
}

function createVersions(
  root: RootIdentity,
  options: OpenGameRootOptions,
  active: () => void,
): GameVersionCapability {
  const checked = async <T>(operation: () => Promise<T>): Promise<T> => {
    active();
    await assertSameRoot(root);
    return operation();
  };
  return {
    ensureRepository: () => checked(() => options.versioning.ensureRepository(root.path)),
    createVersion: (message) => checked(() => options.versioning.createVersion(root.path, message)),
    currentVersion: () => checked(() => options.versioning.currentVersion(root.path)),
    listVersions: () => checked(() => options.versioning.listVersions(root.path)),
    readFileAtVersion: (tag, relativePath) =>
      checked(() => options.versioning.readFileAtVersion(root.path, tag, relativePath)),
  };
}

/** ForgeaX product adapter for `.forgeax/games/<slug>` workspaces. */
export function createForgeaxWorkspaceAdapter(
  options: ForgeaxWorkspaceAdapterOptions = {},
): WorkspaceAdapter {
  const gamesRoot = resolve(options.projectRoot ?? defaultProjectRoot(), '.forgeax', 'games');
  return {
    async resolveGameRoot(gameId): Promise<string> {
      assertGameId(gameId);
      const path = resolve(gamesRoot, gameId);
      try {
        await openRoot(gamesRoot, gameId, false);
      } catch (error) {
        if (!missing(error) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      return path;
    },

    async withGameRoot<T>(
      gameId: string,
      scopeOptions: OpenGameRootOptions,
      operation: (scope: ScopedGameRoot) => Promise<T>,
    ): Promise<T> {
      assertGameId(gameId);
      const root = await openRoot(gamesRoot, gameId, scopeOptions.create);
      let isActive = true;
      const active = (): void => {
        if (!isActive) throw new Error('Scoped game-root authority is no longer active');
      };
      try {
        return await operation({
          gameRoot: root.path,
          files: createFiles(root, active),
          versions: createVersions(root, scopeOptions, active),
        });
      } finally {
        isActive = false;
      }
    },
  };
}
