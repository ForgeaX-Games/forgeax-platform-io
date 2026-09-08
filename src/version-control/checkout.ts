import { createHash } from 'node:crypto';
import { CommandError } from './errors';
import { appendJournalEntry, findJournalRequest } from './journal';
import { withRepositoryLock } from './lock';
import { resolveRepositoryExecutable, inspectRepositoryRoot } from './root';
import { runGit } from './process';
import { readRepositorySnapshot } from './status';
import { resolveTagCommit } from './tag';
import { readLatestRef } from './latest-ref';

export interface CheckoutInput { tag: string; expectedCommit: string; requestId?: string }
export interface SwitchReceipt { requestId?: string; targetTag: string; targetCommit: string; repositoryIdentity: string; detached: boolean; filesVerified: boolean }
export type CheckoutResult = { ok: true; receipt: SwitchReceipt } | { ok: false; error: CommandError; receipt?: Partial<SwitchReceipt> };

async function resolveLatestUntaggedCommit(gameRoot: string, executable: string): Promise<string | null> {
  const latestRef = await readLatestRef(gameRoot);
  const head = (() => {
    try { return runGit({ executable, cwd: gameRoot, args: ['rev-parse', 'HEAD'] }).stdout.trim() || null; } catch { return null; }
  })();
  for (const candidate of [latestRef, head]) {
    if (!candidate) continue;
    try {
      const tags = runGit({ executable, cwd: gameRoot, args: ['tag', '--points-at', candidate] }).stdout.trim();
      if (!tags) return candidate;
    } catch {
      return null;
    }
  }
  return null;
}

export async function checkoutDetached(gameRoot: string, input: CheckoutInput): Promise<CheckoutResult> {
  return withRepositoryLock(gameRoot, async () => {
    const requestId = input.requestId;
    const payloadHash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (requestId) {
      const previous = await findJournalRequest(gameRoot, requestId, payloadHash);
      if (previous === 'conflict') return { ok: false, error: new CommandError({ code: 'version-control-request-conflict', hint: 'Use a new requestId for a different switch target', stage: 'replay', requestId, recoveryActions: ['version-control.refresh'] }) };
      if (previous?.stage === 'completed' && previous.result && typeof previous.result === 'object') return { ok: true, receipt: previous.result as SwitchReceipt };
      if (previous) return { ok: false, error: new CommandError({ code: 'version-control-recovery-required', hint: 'Inspect the repository before retrying this switch', stage: 'replay', requestId, recoveryActions: ['version-control.refresh'] }) };
    }
    if (input.tag.includes('\0') || input.expectedCommit.includes('\0') || !/^[0-9a-f]{40}$/.test(input.expectedCommit)) {
      return { ok: false, error: new CommandError({ code: 'version-control-invalid-target', hint: 'Refresh the version graph and choose a Git commit', stage: 'checkout-preflight' }) };
    }
    const root = await inspectRepositoryRoot(gameRoot);
    if (!root.ok) return { ok: false, error: new CommandError({ code: root.code, hint: 'Initialize the current game repository', stage: 'checkout-preflight', recoveryActions: ['versionControl.initialize'] }) };
    const before = await readRepositorySnapshot(gameRoot);
    if (!before.ok) return { ok: false, error: new CommandError({ code: before.code, hint: 'Refresh repository status', stage: 'checkout-preflight' }) };
    if (before.dirty) return { ok: false, error: new CommandError({ code: 'version-control-worktree-dirty', hint: 'Publish or save all files before switching', stage: 'checkout-preflight', recoveryActions: ['versionControl.publish'] }) };
    const executable = await resolveRepositoryExecutable();
    const target = input.tag === '@latest' || input.tag === 'latest'
      ? await resolveLatestUntaggedCommit(gameRoot, executable)
      : await resolveTagCommit(gameRoot, input.tag);
    if (!target || target !== input.expectedCommit) return { ok: false, error: new CommandError({ code: 'version-control-target-stale', hint: 'Refresh the version graph', stage: 'checkout-recheck', expected: input.expectedCommit, actual: target }) };
    const baseEntry = { schemaVersion: 1 as const, requestId: requestId ?? `switch-${Date.now()}`, operation: 'switch', payloadHash, repositoryIdentity: before.repositoryIdentity, beforeHead: before.head };
    await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'accepted' });
    try {
      runGit({ executable, cwd: gameRoot, args: ['checkout', '--detach', target] });
    } catch (error) {
      const after = await readRepositorySnapshot(gameRoot);
      await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'partial', result: { targetCommit: target }, error: String(error) });
      return { ok: false, error: new CommandError({ code: after.ok && after.head === before.head && !after.dirty ? 'version-control-checkout-failed' : 'version-control-recovery-required', hint: 'Inspect the repository externally before writing again', stage: 'checkout', cause: String(error), recoveryActions: ['version-control.refresh'] }) };
    }
    const after = await readRepositorySnapshot(gameRoot);
    if (!after.ok || after.head !== target || after.dirty) return { ok: false, error: new CommandError({ code: 'version-control-recovery-required', hint: 'Inspect the repository externally before writing again', stage: 'checkout-postflight', expected: target, actual: after.ok ? { head: after.head, dirty: after.dirty } : after.code }) };
    const receipt = { requestId: input.requestId, targetTag: input.tag, targetCommit: target, repositoryIdentity: root.repository.identity, detached: true, filesVerified: true };
    await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'completed', result: receipt });
    return { ok: true, receipt };
  });
}
