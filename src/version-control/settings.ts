import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export interface GitSettings { gitExecutablePath?: string }

export function gitSettingsPath(env: NodeJS.ProcessEnv = process.env): string {
  if (process.platform === 'win32') return join(env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'ForgeaX', 'editor', 'git.json');
  return join(env.XDG_CONFIG_HOME ?? join(homedir(), '.forgeax'), 'editor', 'git.json');
}

export function loadGitSettings(path = gitSettingsPath()): GitSettings {
  try {
    const value = JSON.parse(readFileSync(path, 'utf8')) as GitSettings;
    return typeof value.gitExecutablePath === 'string' ? { gitExecutablePath: value.gitExecutablePath } : {};
  } catch { return {}; }
}

export function saveGitSettings(settings: GitSettings, path = gitSettingsPath()): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify({ gitExecutablePath: settings.gitExecutablePath }, null, 2)}\n`, { mode: 0o600 });
}
