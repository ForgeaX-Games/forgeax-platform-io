/**
 * Startup recovery decisions for one prepared filesystem mutation.
 *
 * HEAD is the only public commit point. A prepared record is therefore either
 * still before HEAD, already after HEAD, or impossible to classify safely.
 */
import { createResourceError, type ResourceError, type ResourceResult } from './contract';

export type PreparedRecoveryDecision = 'keep-before' | 'keep-after';

export const MAX_LINEAGE_NODES = 100_000;

export interface ObserverRecoveryIntent {
  readonly kind: 'scoped-reconcile';
  readonly rootId: string;
  readonly scope: string;
  readonly reason: 'observer-gap' | 'observer-invalidation' | 'observer-error' | 'vcs-burst' | 'late-root';
  readonly lastKnownGoodRevision: string;
}

export function createObserverRecoveryIntent(input: {
  readonly rootId: string;
  readonly scope: string;
  readonly reason: ObserverRecoveryIntent['reason'];
  readonly lastKnownGoodRevision: string;
}): ObserverRecoveryIntent {
  return Object.freeze({ ...input, kind: 'scoped-reconcile' as const });
}

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

export async function classifyPreparedRecoveryWithLineage(input: {
  readonly beforeRevision: string;
  readonly currentRevision: string;
  readonly afterRevision: string;
  readonly readManifest: (revision: string) => Promise<{
    readonly revision: string;
    readonly parentRevision?: string | null;
  }>;
}): Promise<ResourceResult<PreparedRecoveryDecision>> {
  const { beforeRevision, currentRevision, afterRevision } = input;
  if (![beforeRevision, currentRevision, afterRevision].every(isRevisionToken)) {
    return { ok: false, error: recoveryRequiredError('lineage contains an invalid revision token') };
  }
  try {
    const before = await input.readManifest(beforeRevision);
    if (before.revision !== beforeRevision) return { ok: false, error: recoveryRequiredError('before manifest revision does not match its path') };
    const after = await input.readManifest(afterRevision);
    if (after.revision !== afterRevision || after.parentRevision !== beforeRevision) {
      return { ok: false, error: recoveryRequiredError('prepared after manifest has an invalid parent or revision') };
    }
    if (currentRevision === beforeRevision) return { ok: true, value: 'keep-before' };
    if (currentRevision === afterRevision) return { ok: true, value: 'keep-after' };

    const visited = new Set<string>();
    let cursor = currentRevision;
    for (let count = 0; count < MAX_LINEAGE_NODES; count += 1) {
      if (visited.has(cursor)) {
        return { ok: false, error: recoveryRequiredError('lineage contains a cycle or duplicate revision') };
      }
      visited.add(cursor);
      if (cursor === afterRevision) return { ok: true, value: 'keep-after' };
      if (cursor === beforeRevision) {
        return { ok: false, error: recoveryRequiredError('HEAD advanced from before without prepared after in lineage') };
      }
      const manifest = await input.readManifest(cursor);
      if (manifest.revision !== cursor || !manifest.parentRevision || !isRevisionToken(manifest.parentRevision)) {
        return { ok: false, error: recoveryRequiredError('lineage parent is missing or invalid') };
      }
      cursor = manifest.parentRevision;
    }
    return { ok: false, error: recoveryRequiredError(`lineage exceeds ${MAX_LINEAGE_NODES} nodes`) };
  } catch (error) {
    return {
      ok: false,
      error: recoveryRequiredError(`lineage could not be validated: ${error instanceof Error ? error.message : String(error)}`),
    };
  }
}

function isRevisionToken(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value.length > 0;
}
