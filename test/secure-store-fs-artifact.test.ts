import { describe, expect, test } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  SECURE_STORE_FS_TARGETS,
  aggregateArtifacts,
  createArtifactMetadata,
  validateAggregateManifest,
  validateArtifactMetadata,
  writeArtifactMetadata,
} from '../scripts/secure-store-fs-artifact.mjs';

const sourceHead = 'artifact-test-head';

function nativeFixture(target: string): Buffer {
  const bytes = Buffer.alloc(64, 0);
  if (target.startsWith('darwin-')) {
    bytes.writeUInt32LE(0xfeedfacf, 0);
    bytes.writeUInt32LE(target === 'darwin-arm64' ? 0x0100000c : 0x01000007, 4);
  } else {
    bytes[0] = 0x7f;
    bytes[1] = 0x45;
    bytes[2] = 0x4c;
    bytes[3] = 0x46;
    bytes[4] = 2;
    bytes[5] = 1;
    bytes.writeUInt16LE(target === 'linux-arm64' ? 183 : 62, 18);
  }
  return bytes;
}

function writeFixture(directory: string, target: string, marker = ''): string {
  const binary = join(directory, `secure-store-fs-${target}`);
  writeFileSync(binary, Buffer.concat([nativeFixture(target), Buffer.from(marker)]), { mode: 0o700 });
  chmodSync(binary, 0o700);
  return binary;
}

describe('secure-store-fs source-derived artifact contract', () => {
  test('validates exact metadata, target identity, mode, hash, and release barrier exclusion', () => {
    const directory = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-artifact-meta-'));
    try {
      const binary = writeFixture(directory, 'linux-x64');
      const metadataPath = `${binary}.json`;
      const metadata = writeArtifactMetadata({ binaryPath: binary, metadataPath, target: 'linux-x64', sourceHead });
      expect(Object.keys(metadata).sort()).toEqual(['bytes', 'protocolVersion', 'schemaVersion', 'sha256', 'sourceHead', 'target']);
      expect(validateArtifactMetadata({ binaryPath: binary, metadataPath, expectedTarget: 'linux-x64', expectedSourceHead: sourceHead })).toEqual(metadata);
      expect(() => createArtifactMetadata({ binaryPath: binary, target: 'linux-arm64', sourceHead })).toThrow();
      chmodSync(binary, 0o600);
      expect(() => createArtifactMetadata({ binaryPath: binary, target: 'linux-x64', sourceHead })).toThrow();
      chmodSync(binary, 0o700);
      writeFileSync(metadataPath, JSON.stringify({ ...metadata, sha256: '0'.repeat(64) }));
      expect(() => validateArtifactMetadata({ binaryPath: binary, metadataPath, expectedTarget: 'linux-x64', expectedSourceHead: sourceHead })).toThrow();
      const barrierBinary = writeFixture(directory, 'linux-x64', 'forgeax-secure-store-fs:test-barriers');
      expect(() => createArtifactMetadata({ binaryPath: barrierBinary, target: 'linux-x64', sourceHead })).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test('aggregates exactly four native targets and rejects missing, duplicate, unexpected, or stale rows', () => {
    const input = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-artifact-input-'));
    const output = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-artifact-output-'));
    try {
      for (const target of SECURE_STORE_FS_TARGETS) {
        const targetDirectory = join(input, target);
        mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
        const binary = writeFixture(targetDirectory, target);
        writeArtifactMetadata({ binaryPath: binary, target, sourceHead });
        // Artifact upload/download retains bytes but loses executable mode.
        chmodSync(binary, 0o600);
      }
      const manifest = aggregateArtifacts({ inputDirectory: input, outputDirectory: output, sourceHead });
      expect(manifest.targets.map((row) => row.target)).toEqual([...SECURE_STORE_FS_TARGETS]);
      expect(validateAggregateManifest({ manifestPath: join(output, 'manifest.json'), expectedSourceHead: sourceHead })).toEqual(manifest);
      const copied = readFileSync(join(output, 'secure-store-fs-linux-x64'));
      expect(copied.toString('hex')).toBe(nativeFixture('linux-x64').toString('hex'));
      expect(statSync(join(output, 'secure-store-fs-linux-x64')).mode & 0o111).not.toBe(0);

      const unexpected = join(input, 'secure-store-fs-surprise');
      writeFileSync(unexpected, nativeFixture('linux-x64'), { mode: 0o700 });
      chmodSync(unexpected, 0o700);
      expect(() => aggregateArtifacts({ inputDirectory: input, outputDirectory: join(input, 'unexpected-out'), sourceHead })).toThrow();
      rmSync(unexpected, { force: true });

      const staleRowPath = join(output, 'manifest.json');
      const staleManifest = JSON.parse(readFileSync(staleRowPath, 'utf8')) as { targets: Array<Record<string, unknown>> };
      staleManifest.targets[0] = { ...staleManifest.targets[0], sha256: '0'.repeat(64) };
      writeFileSync(staleRowPath, `${JSON.stringify(staleManifest)}\n`);
      expect(() => validateAggregateManifest({ manifestPath: staleRowPath, expectedSourceHead: sourceHead })).toThrow();

      const missingInput = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-artifact-missing-'));
      try {
        for (const target of SECURE_STORE_FS_TARGETS.slice(0, -1)) {
          const targetDirectory = join(missingInput, target);
          mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
          const binary = writeFixture(targetDirectory, target);
          writeArtifactMetadata({ binaryPath: binary, target, sourceHead });
        }
        expect(() => aggregateArtifacts({ inputDirectory: missingInput, outputDirectory: join(missingInput, 'out'), sourceHead })).toThrow();
      } finally {
        rmSync(missingInput, { recursive: true, force: true });
      }

      const duplicateInput = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-artifact-duplicate-'));
      try {
        for (const target of SECURE_STORE_FS_TARGETS) {
          const targetDirectory = join(duplicateInput, target);
          mkdirSync(targetDirectory, { recursive: true, mode: 0o700 });
          const binary = writeFixture(targetDirectory, target);
          writeArtifactMetadata({ binaryPath: binary, target, sourceHead });
        }
        const duplicateDirectory = join(duplicateInput, 'duplicate-linux-x64');
        mkdirSync(duplicateDirectory, { recursive: true, mode: 0o700 });
        const duplicateBinary = writeFixture(duplicateDirectory, 'linux-x64');
        writeArtifactMetadata({ binaryPath: duplicateBinary, target: 'linux-x64', sourceHead });
        expect(() => aggregateArtifacts({ inputDirectory: duplicateInput, outputDirectory: join(duplicateInput, 'out'), sourceHead })).toThrow();
      } finally {
        rmSync(duplicateInput, { recursive: true, force: true });
      }
    } finally {
      rmSync(input, { recursive: true, force: true });
      rmSync(output, { recursive: true, force: true });
    }
  });
});
