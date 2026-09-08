export interface CommandErrorInit {
  code: string;
  hint: string;
  stage: string;
  expected?: unknown;
  actual?: unknown;
  requestId?: string;
  commitIdentity?: string;
  recoveryActions?: readonly string[];
  cause?: string;
}

export class CommandError extends Error {
  readonly code: string;
  readonly hint: string;
  readonly stage: string;
  readonly expected?: unknown;
  readonly actual?: unknown;
  readonly requestId?: string;
  readonly commitIdentity?: string;
  readonly recoveryActions: readonly string[];
  readonly causeText?: string;

  constructor(init: CommandErrorInit) {
    super(init.code);
    this.name = 'CommandError';
    this.code = init.code;
    this.hint = init.hint;
    this.stage = init.stage;
    this.expected = init.expected;
    this.actual = init.actual;
    this.requestId = init.requestId;
    this.commitIdentity = init.commitIdentity;
    this.recoveryActions = init.recoveryActions ?? [];
    this.causeText = init.cause;
  }

  toJSON(): Record<string, unknown> {
    return {
      code: this.code,
      hint: this.hint,
      stage: this.stage,
      expected: this.expected,
      actual: this.actual,
      requestId: this.requestId,
      commitIdentity: this.commitIdentity,
      recoveryActions: this.recoveryActions,
      cause: this.causeText,
    };
  }
}

export function asCommandError(error: unknown, stage: string): CommandError {
  if (error instanceof CommandError) return error;
  return new CommandError({
    code: 'version-control-command-failed',
    hint: 'Inspect the repository and retry',
    stage,
    cause: error instanceof Error ? error.message.slice(0, 512) : String(error).slice(0, 512),
    recoveryActions: ['version-control.refresh'],
  });
}
