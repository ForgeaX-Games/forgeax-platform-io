import type {
  CurrentVersion as HostCurrentVersion,
  GameVersion,
  VersionAdapter,
} from '@forgeax/workbench-host/contracts';
import {
  createVersion,
  currentVersion,
  ensureGameRepository,
  listVersions,
  readGameFileAtTag,
} from '../api/lib/game-git';

function toIsoTime(seconds: number): string {
  return new Date(seconds * 1000).toISOString();
}

function findVersion(gameRoot: string, tag: string): GameVersion {
  const entry = listVersions(gameRoot).find((version) => version.tag === tag);
  if (!entry) {
    throw new Error(`Created version ${tag} was not found`);
  }
  if (!entry.commitHash) {
    throw new Error(`Created version ${tag} has no commit`);
  }
  return {
    tag,
    commitHash: entry.commitHash,
    message: entry.message,
    createdAt: toIsoTime(entry.createdAt),
  };
}

/** Map ForgeaX's existing annotated vN repositories to the shared Host contract. */
export function createForgeaxVersionAdapter(): VersionAdapter {
  return {
    async ensureRepository(gameRoot): Promise<void> {
      ensureGameRepository(gameRoot);
    },

    async createVersion(gameRoot, message): Promise<GameVersion> {
      const created = createVersion(gameRoot, message);
      if (!created.tag) {
        throw new Error('ForgeaX version creation returned no tag');
      }
      return findVersion(gameRoot, created.tag);
    },

    async currentVersion(gameRoot): Promise<HostCurrentVersion | null> {
      const current = currentVersion(gameRoot);
      if (!current.tag || !current.commitHash) return null;
      return {
        tag: current.tag,
        commitHash: current.commitHash,
        dirty: current.dirty,
      };
    },

    async listVersions(gameRoot): Promise<GameVersion[]> {
      return listVersions(gameRoot).map((version) => ({
        tag: version.tag,
        commitHash: version.commitHash,
        message: version.message,
        createdAt: toIsoTime(version.createdAt),
      }));
    },

    async readFileAtVersion(gameRoot, tag, relativePath): Promise<Uint8Array | null> {
      return readGameFileAtTag(gameRoot, tag, relativePath);
    },
  };
}
