/**
 * Startup recovery decisions for one prepared filesystem mutation.
 *
 * HEAD is the only public commit point. A prepared record is therefore either
 * still before HEAD, already after HEAD, or impossible to classify safely.
 */
import { createResourceError, type ResourceError, type ResourceResult } from './contract';

export type PreparedRecoveryDecision = 'keep-before' | 'keep-after';

export function classifyPreparedRecovery(
  beforeRevision: string,
  currentRevision: string,
  afterRevision: string,
): ResourceResult<PreparedRecoveryDecision> {
  if (currentRevision === beforeRevision) return { ok: true, value: 'keep-before' };
  if (currentRevision === afterRevision) return { ok: true, value: 'keep-after' };
  return {
    ok: false,
    error: recoveryRequiredError(
      `HEAD ${currentRevision} is neither prepared before revision ${beforeRevision} nor after revision ${afterRevision}.`,
    ),
  };
}

export function recoveryRequiredError(reason: string): ResourceError {
  return createResourceError('recovery-required', {
    storageReason: reason,
    retryable: false,
  });
}
