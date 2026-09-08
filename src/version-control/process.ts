import { spawnSync } from 'node:child_process';
import { CommandError } from './errors';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_OUTPUT = 1_048_576;
const HOOKS_PATH = process.platform === 'win32' ? 'NUL' : '/dev/null';

export interface GitProcessOptions {
  executable: string;
  cwd: string;
  args: readonly string[];
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GitProcessResult {
  stdout: string;
  stderr: string;
  status: number;
}

function safeArgs(args: readonly string[]): string[] {
  if (args.some((arg) => arg.includes('\0'))) {
    throw new CommandError({ code: 'version-control-invalid-argv', hint: 'Remove NUL characters', stage: 'validate-argv' });
  }
  return [
    '-c', `core.hooksPath=${HOOKS_PATH}`,
    '-c', 'commit.gpgsign=false',
    '-c', 'tag.gpgSign=false',
    ...args,
  ];
}

export function runGit(options: GitProcessOptions): GitProcessResult {
  if (!options.executable.startsWith('/') && process.platform !== 'win32') {
    throw new CommandError({ code: 'version-control-executable-not-absolute', hint: 'Configure an absolute Git executable', stage: 'validate-executable' });
  }
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
  const result = spawnSync(options.executable, safeArgs(options.args), {
    cwd: options.cwd,
    shell: false,
    windowsHide: true,
    timeout,
    encoding: 'buffer',
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: ':', GIT_SEQUENCE_EDITOR: ':' },
  });
  const stdout = Buffer.from(result.stdout ?? '').subarray(0, max).toString('utf8');
  const stderr = Buffer.from(result.stderr ?? '').subarray(0, max).toString('utf8');
  if (result.error || result.status !== 0) {
    throw new CommandError({
      code: result.signal === 'SIGTERM' ? 'version-control-command-timeout' : 'version-control-command-failed',
      hint: 'Inspect the bounded command cause and retry',
      stage: 'git-command',
      cause: (result.error?.message ?? stderr).slice(0, 512),
    });
  }
  return { stdout, stderr, status: result.status ?? 0 };
}

export function runGitText(options: GitProcessOptions): string {
  return runGit(options).stdout;
}
