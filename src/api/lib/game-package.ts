// game-package.ts — per-game repo file IO for the game-host API.
//
// A "game package" is three structured JSON files at the root of a game repo
// (`.forgeax/games/<slug>/`), per the storage design SPEC
// (docs/superpowers/specs/2026-07-22-game-package-storage-design.md):
//
//   project.json           — project metadata (id/title/platform/entry)
//   blueprint.json         — the gameplay SSOT (opaque JSON to platform-io)
//   assets/manifest.json   — asset id → url table (opaque JSON)
//
// platform-io stays business-agnostic: it only reads/writes these three files
// as opaque JSON at fixed paths. Blueprint/manifest *shape* validation lives in
// the wb-game-video extension, not here.
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

function readJson(p: string): unknown | null {
  if (!existsSync(p)) return null;
  try {
    return JSON.parse(readFileSync(p, 'utf-8'));
  } catch {
    return null;
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
  const manifest = input.assetsManifest ?? readJson(resolve(dir, ...MANIFEST_SEGS)) ?? { assets: {} };

  writeJsonAtomic(resolve(dir, PROJECT_FILE), project);
  writeJsonAtomic(resolve(dir, BLUEPRINT_FILE), input.blueprint);
  writeJsonAtomic(resolve(dir, ...MANIFEST_SEGS), manifest);
}
