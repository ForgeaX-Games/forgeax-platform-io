import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { runGitText } from './process';
import { loadGitSettings, saveGitSettings, type GitSettings } from './settings';

export type GitCandidateSource = 'saved' | 'path' | 'platform' | 'manual';
export interface GitExecutableCandidate { source: GitCandidateSource; path: string }
export interface GitExecutableSuccess { ok: true; path: string; source: GitCandidateSource; version: string }
export interface GitExecutableFailure { ok: false; code: 'unavailable'; candidates: readonly string[]; cause?: string }
export type GitExecutableResult = GitExecutableSuccess | GitExecutableFailure;

function platformCandidates(): string[] {
  if (process.platform === 'win32') {
    return [join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'cmd', 'git.exe'), join(process.env.LOCALAPPDATA ?? '', 'Programs', 'Git', 'cmd', 'git.exe')];
  }
  return process.platform === 'darwin' ? ['/opt/homebrew/bin/git', '/usr/local/bin/git', '/usr/bin/git'] : ['/usr/bin/git', '/usr/local/bin/git'];
}

function pathCandidate(): string | null {
  const pathValue = process.env.PATH ?? '';
  for (const dir of pathValue.split(process.platform === 'win32' ? ';' : ':')) {
    for (const name of process.platform === 'win32' ? ['git.exe', 'git.cmd'] : ['git']) {
      const candidate = join(dir, name);
      try { accessSync(candidate, constants.X_OK); return candidate; } catch { /* try next */ }
    }
  }
  return null;
}

export async function validateGitExecutable(candidate: string): Promise<GitExecutableSuccess | GitExecutableFailure> {
  try {
    if (!candidate || (candidate !== 'git' && !candidate.includes('/') && !candidate.includes('\\'))) {
      return { ok: false, code: 'unavailable', candidates: [candidate] };
    }
    const resolvedCandidate = candidate.includes('/') || candidate.includes('\\') ? candidate : pathCandidate() ?? candidate;
    const absolute = realpathSync(resolvedCandidate);
    const details = statSync(absolute);
    if (!details.isFile()) return { ok: false, code: 'unavailable', candidates: [candidate] };
    accessSync(absolute, constants.X_OK);
    const version = runGitText({ executable: absolute, cwd: process.cwd(), args: ['--version'], timeoutMs: 3_000, maxOutputBytes: 8_192 }).trim();
    if (!/^git version\s+\S+/.test(version)) return { ok: false, code: 'unavailable', candidates: [candidate] };
    return { ok: true, path: absolute, source: 'manual', version };
  } catch (error) {
    return { ok: false, code: 'unavailable', candidates: [candidate], cause: error instanceof Error ? error.message : String(error) };
  }
}

export async function resolveGitExecutable(options: { candidates?: readonly GitExecutableCandidate[]; settings?: GitSettings; persist?: boolean } = {}): Promise<GitExecutableResult> {
  const saved = options.settings?.gitExecutablePath ?? loadGitSettings().gitExecutablePath;
  const candidates = options.candidates ? [...options.candidates] : [
    ...(saved ? [{ source: 'saved' as const, path: saved }] : []),
    ...(pathCandidate() ? [{ source: 'path' as const, path: pathCandidate()! }] : []),
    ...platformCandidates().map((path) => ({ source: 'platform' as const, path })),
  ];
  const attempted: string[] = [];
  for (const candidate of candidates) {
    attempted.push(candidate.path);
    const result = await validateGitExecutable(candidate.path);
    if (result.ok) {
      const success = { ...result, source: candidate.source };
      if (options.persist !== false && candidate.source !== 'manual') saveGitSettings({ gitExecutablePath: success.path });
      return success;
    }
  }
  return { ok: false, code: 'unavailable', candidates: attempted };
}
