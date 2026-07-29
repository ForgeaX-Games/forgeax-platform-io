import { describe, expect, test } from 'bun:test';
import * as publicEntry from '@forgeax/platform-io';

const legacyPublicSymbols = [
  'ALLOWED_TOP_DIRS',
  'WHITELIST_ERROR',
  'addKnownGame',
  'agentPackLayerRoot',
  'appendToStream',
  'assetRoot',
  'classify',
  'createBootSplashRouter',
  'createChangelogRouter',
  'createFilesRouter',
  'createFsBrowserRouter',
  'createGameAssetsRouter',
  'createGameHostRouter',
  'createGameVersion',
  'createLogsRouter',
  'createPrefsRouter',
  'createVersionRouter',
  'currentGameVersion',
  'defaultProject',
  'defaultProjectRoot',
  'friendlyPath',
  'getVersion',
  'interfaceDist',
  'knownGamesFile',
  'listTree',
  'loadKnownGames',
  'logsDir',
  'mp',
  'parseChangelog',
  'readFileSafe',
  'readGamePackage',
  'readUninstalledAgentIds',
  'removeKnownGame',
  'resolveSafePath',
  'singleGameFileBackend',
  'studioFileBackend',
  'writeAgentPack',
  'writeFileSafe',
  'writeGamePackage',
  'writeUninstalledAgentIds',
] as const;

describe('public platform-io surface', () => {
  test('keeps every legacy runtime symbol available from the package entry', () => {
    const exportedNames = Object.keys(publicEntry);

    for (const symbol of legacyPublicSymbols) {
      expect(exportedNames).toContain(symbol);
      expect(publicEntry[symbol as keyof typeof publicEntry]).toBeDefined();
    }
  });

  test('does not use private API paths as the consumer entry', () => {
    expect(import.meta.url).not.toContain('/src/api/');
  });
});
