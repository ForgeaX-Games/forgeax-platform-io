// game-git.ts — per-game git versioning for the game-host API.
//
// Each game repo (`.forgeax/games/<slug>/`) is its own git repo. A "version" is
// an annotated tag `vN` (v1, v2, …) on a commit — the model is aligned with
// Arrival/kino's git-version: post-save commit + sequential annotated tag.
//
// The product only ever creates the next version and reads the current one;
// checkout/rollback stay internal (not exposed by the router).

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

// Runtime state that must never enter a game version (agent sessions, logs,
// caches, deps). Kept minimal + generic; games may add their own lines.
const DEFAULT_IGNORES = ['sessions/', '*.log', 'node_modules/', '.DS_Store'];

// Inline identity + no-gpg so commits/tags never depend on ambient git config
// (fresh game repos have none; CI/desktop must not prompt or fail).
const IDENTITY = [
  '-c', 'user.name=forgeax-game-host',
  '-c', 'user.email=game-host@forgeax.local',
  '-c', 'commit.gpgsign=false',
];

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: dir,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function hasRepo(dir: string): boolean {
  return existsSync(resolve(dir, '.git'));
}

function ensureRepo(dir: string): void {
  if (hasRepo(dir)) return;
  git(dir, ['init']);
}

/**
 * Ensure the game repo has a `.gitignore` covering runtime state, so versions
 * don't capture agent sessions / logs / caches. Idempotent + non-destructive:
 * creates the file if absent, else appends only the missing default lines
 * (never clobbers a game's own entries).
 */
function ensureGitignore(dir: string): void {
  const path = resolve(dir, '.gitignore');
  let existing = '';
  try {
    existing = readFileSync(path, 'utf-8');
  } catch {
    /* absent */
  }
  const present = new Set(existing.split(/\r?\n/).map((l) => l.trim()).filter(Boolean));
  const missing = DEFAULT_IGNORES.filter((d) => !present.has(d));
  if (missing.length === 0) return;
  const head = existing
    ? existing.replace(/\s*$/, '') + '\n'
    : '# forgeax game-host: keep runtime state out of versions\n';
  writeFileSync(path, head + missing.join('\n') + '\n');
}

/**
 * Drop already-tracked runtime state from the index (e.g. `sessions/` committed
 * before the ignore existed) so it leaves the next version. Files stay on disk;
 * `--ignore-unmatch` keeps it a no-op when nothing matches.
 */
function untrackRuntimeState(dir: string): void {
  if (!hasHead(dir)) return;
  try {
    git(dir, ['rm', '-r', '--cached', '--ignore-unmatch', 'sessions']);
  } catch {
    /* best-effort */
  }
}

/** Parse existing `vN` tags → their numbers (ignores non-`vN` tags). */
function versionNumbers(dir: string): number[] {
  let out = '';
  try {
    out = git(dir, ['tag', '--list', 'v*']);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((t) => t.trim())
    .map((t) => /^v(\d+)$/.exec(t))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => Number(m[1]))
    .filter((n) => Number.isFinite(n));
}

export interface CreatedVersion {
  tag: string | null;
  commitHash: string | null;
  /** true when nothing changed → no new version created; returns current latest. */
  unchanged?: boolean;
}

function hasHead(dir: string): boolean {
  try {
    git(dir, ['rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

/**
 * Create the next version **only when there are changes**: init (if needed) →
 * `add -A` → (commit iff staged changes) → annotated tag `v{max+1}`. Respects
 * `.gitignore`. When the working tree is unchanged, returns the current latest
 * tag with `unchanged: true` (no empty commit/tag proliferation on repeated save).
 */
export function createVersion(dir: string, message?: string): CreatedVersion {
  ensureRepo(dir);
  ensureGitignore(dir); // keep sessions/logs/caches out of versions
  untrackRuntimeState(dir); // drop any previously-committed runtime state
  git(dir, ['add', '-A']);
  const head = hasHead(dir);
  const staged = git(dir, ['diff', '--cached', '--name-only']).length > 0;
  const nums = versionNumbers(dir).sort((a, b) => a - b);
  const latest = nums.length ? `v${nums[nums.length - 1]}` : null;

  // Nothing to commit and a version already exists → no-op (return current).
  if (head && !staged && latest) {
    return { tag: latest, commitHash: git(dir, ['rev-parse', 'HEAD']), unchanged: true };
  }

  const next = (nums.length ? nums[nums.length - 1] : 0) + 1;
  const tag = `v${next}`;
  const msg = (message && message.trim()) || `[game-host] ${tag}`;
  if (staged || !head) git(dir, [...IDENTITY, 'commit', '-m', msg]); // commit iff there are changes / first commit
  git(dir, [...IDENTITY, 'tag', '-a', tag, '-m', msg]);
  return { tag, commitHash: git(dir, ['rev-parse', 'HEAD']) };
}

export interface CurrentVersion {
  tag: string | null;
  commitHash: string | null;
  dirty: boolean;
}

export interface VersionEntry {
  tag: string;
  /** annotated-tag creation time (unix seconds). */
  createdAt: number;
  /** tag message (subject). */
  message: string;
}

/** List all `vN` versions (newest first), read-only. Empty when no repo/tags. */
export function listVersions(dir: string): VersionEntry[] {
  if (!hasRepo(dir)) return [];
  let out = '';
  try {
    out = git(dir, [
      'for-each-ref',
      'refs/tags/v*',
      '--format=%(refname:short)\t%(creatordate:unix)\t%(subject)',
    ]);
  } catch {
    return [];
  }
  return out
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const [tag, ts, ...rest] = l.split('\t');
      return { tag, createdAt: Number(ts) || 0, message: rest.join('\t') };
    })
    .filter((v) => /^v\d+$/.test(v.tag))
    .sort((a, b) => {
      const na = Number(a.tag.slice(1));
      const nb = Number(b.tag.slice(1));
      return nb - na; // newest (highest vN) first
    });
}

/**
 * Read a game package **at a given version tag** without touching the working
 * tree or history (`git show <tag>:<file>`). Returns parsed JSON per file, each
 * `null` when absent/unparseable at that tag. Used for non-destructive "load an
 * old version into the editor" — the editor then saves it as a new version.
 */
export function readPackageAtTag(
  dir: string,
  tag: string,
): { project: unknown | null; blueprint: unknown | null; assetsManifest: unknown | null } | null {
  if (!/^v\d+$/.test(tag)) return null;
  if (!hasRepo(dir)) return null;
  const showJson = (file: string): unknown | null => {
    try {
      const raw = git(dir, ['show', `${tag}:${file}`]);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  };
  // tag must exist
  try {
    git(dir, ['rev-parse', `${tag}^{}`]);
  } catch {
    return null;
  }
  return {
    project: showJson('project.json'),
    blueprint: showJson('blueprint.json'),
    assetsManifest: showJson('assets/manifest.json'),
  };
}

/** Latest `vN` tag + HEAD hash + working-tree dirty flag. */
export function currentVersion(dir: string): CurrentVersion {
  if (!hasRepo(dir)) return { tag: null, commitHash: null, dirty: false };
  let commitHash: string | null = null;
  try {
    commitHash = git(dir, ['rev-parse', 'HEAD']);
  } catch {
    commitHash = null;
  }
  const nums = versionNumbers(dir).sort((a, b) => a - b);
  const tag = nums.length ? `v${nums[nums.length - 1]}` : null;
  let dirty = false;
  try {
    dirty = git(dir, ['status', '--porcelain']).length > 0;
  } catch {
    dirty = false;
  }
  return { tag, commitHash, dirty };
}
