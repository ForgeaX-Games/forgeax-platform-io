// game-package.ts — per-game repo file IO for the game-host API.
//
// A "game package" is three structured JSON files at the root of a game repo
// (`.forgeax/games/<slug>/`), per the storage design SPEC
// (docs/superpowers/specs/2026-07-22-game-package-storage-design.md):
//
//   project.json           — project metadata (id/title/platform/entry)
//   blueprint.json         — the gameplay SSOT (opaque JSON to platform-io)
//   assets/manifest.json   — shared v2 asset-record array (opaque records)
//
// platform-io stays business-agnostic: it only reads/writes these three files
// at fixed paths. It enforces the shared manifest envelope and global id
// uniqueness; asset-domain-specific fields remain opaque here.
//
// Writes are atomic-per-file (temp file + rename) so a crashed PUT never leaves
// a half-written blueprint on disk.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { resolve } from 'node:path';

const PROJECT_FILE = 'project.json';
const BLUEPRINT_FILE = 'blueprint.json';
const MANIFEST_SEGS = ['assets', 'manifest.json'] as const;

export interface GamePackage {
  project: unknown | null;
  blueprint: unknown | null;
  assetsManifest: unknown | null;
}

export interface WritePackageInput {
  /** Optional; when omitted, keep existing project.json or synthesize a minimal one. */
  project?: unknown;
  /** Required — the gameplay SSOT. */
  blueprint: unknown;
  /** Optional; when omitted, keep existing manifest or write an empty table. */
  assetsManifest?: unknown;
}

export class GamePackageValidationError extends Error {}

function isCanonicalAssetManifest(value: unknown): value is Record<string, unknown> & { version: 2; assets: unknown[] } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const manifest = value as Record<string, unknown>;
  if (manifest.version !== 2 || !Array.isArray(manifest.assets)) return false;
  const ids = new Set<string>();
  for (const asset of manifest.assets) {
    if (!asset || typeof asset !== 'object' || Array.isArray(asset)) return false;
    const record = asset as Record<string, unknown>;
    const id = record.id;
    if (
      typeof id !== 'string' ||
      id.length === 0 ||
      typeof record.kind !== 'string' ||
      record.kind.length === 0 ||
      ids.has(id)
    ) return false;
    ids.add(id);
  }
  return true;
}

function readJson(p: string): unknown | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
  }
}

function readExistingManifest(p: string): unknown | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    throw new GamePackageValidationError('invalid existing assets manifest');
  }
}

function writeJsonAtomic(p: string, value: unknown): void {
  const tmp = `${p}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, p);
}

/** Minimal project.json used when the caller omits one and none exists on disk. */
export function defaultProject(slug: string): Record<string, unknown> {
  return {
    id: slug,
    title: slug,
    platform: 'wb-game-video',
    platformVersion: '1',
    entry: { blueprint: 'blueprint.json', components: 'dist/components' },
  };
}

/** Read all three files; each is `null` when absent or unparseable. */
export function readGamePackage(dir: string): GamePackage {
  return {
    project: readJson(resolve(dir, PROJECT_FILE)),
    blueprint: readJson(resolve(dir, BLUEPRINT_FILE)),
    assetsManifest: readJson(resolve(dir, ...MANIFEST_SEGS)),
  };
}

/**
 * Transactionally (per-file atomic) write the package. `blueprint` is required;
 * `project` / `assetsManifest` default to existing-on-disk → synthesized empty.
 * Creates the game dir + `assets/` as needed.
 */
export function writeGamePackage(dir: string, slug: string, input: WritePackageInput): void {
  if (input.blueprint == null) throw new Error('missing blueprint');

  mkdirSync(dir, { recursive: true });
  mkdirSync(resolve(dir, 'assets'), { recursive: true });

  const project = input.project ?? readJson(resolve(dir, PROJECT_FILE)) ?? defaultProject(slug);
  const manifest =
    input.assetsManifest ??
    readExistingManifest(resolve(dir, ...MANIFEST_SEGS)) ??
    { version: 2, assets: [] };
  if (!isCanonicalAssetManifest(manifest)) {
    throw new GamePackageValidationError('invalid assets manifest');
  }

  writeJsonAtomic(resolve(dir, PROJECT_FILE), project);
  writeJsonAtomic(resolve(dir, BLUEPRINT_FILE), input.blueprint);
  writeJsonAtomic(resolve(dir, ...MANIFEST_SEGS), manifest);
}
