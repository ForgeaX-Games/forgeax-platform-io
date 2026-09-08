import { createHash } from 'node:crypto';
import { appendJournalEntry, findJournalRequest } from './journal';
import { compareAndSwapLatest, readLatestRef } from './latest-ref';
import { withRepositoryLock } from './lock';
import { CommandError } from './errors';
import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';
import { readRepositorySnapshot } from './status';
import { checkTagName, createAnnotatedTag, resolveTagCommit } from './tag';

export interface PublishInput { tag: string; message: string; expectedSnapshotId: string; requestId?: string }
export interface PublishSuccess { ok: true; tag: string; commitIdentity: string; unchanged?: boolean }
export interface PublishFailure { ok: false; error: CommandError; commitIdentity?: string }
export type PublishResult = PublishSuccess | PublishFailure;

function payloadHash(input: PublishInput): string { return createHash('sha256').update(JSON.stringify(input)).digest('hex'); }
function failure(code: string, stage: string, hint: string, expected?: unknown, actual?: unknown, commitIdentity?: string, requestId?: string): PublishFailure {
  return { ok: false, commitIdentity, error: new CommandError({ code, stage, hint, expected, actual, commitIdentity, requestId, recoveryActions: ['version-control.refresh'] }) };
}

export async function publishVersion(gameRoot: string, input: PublishInput): Promise<PublishResult> {
  return withRepositoryLock(gameRoot, async () => {
    const payload = payloadHash(input);
    if (input.requestId) {
      const previous = await findJournalRequest(gameRoot, input.requestId, payload);
      if (previous === 'conflict') return failure('version-control-request-conflict', 'replay', 'The requestId was already used with a different payload', undefined, undefined, undefined, input.requestId);
      if (previous?.stage === 'completed' && previous.result && typeof previous.result === 'object') {
        const result = previous.result as { tag?: unknown; commitIdentity?: unknown };
        if (typeof result.tag === 'string' && typeof result.commitIdentity === 'string') return { ok: true, tag: result.tag, commitIdentity: result.commitIdentity };
      }
      if (previous) return failure('version-control-partial-publish', 'replay', 'Inspect the repository before retrying this request', undefined, previous.stage, typeof previous.result === 'object' && previous.result && 'commitIdentity' in previous.result ? (previous.result as { commitIdentity?: string }).commitIdentity : undefined, input.requestId);
    }
    if (!await checkTagName(gameRoot, input.tag)) return failure('version-control-invalid-tag', 'validate-tag', 'Use a valid unused Git tag', undefined, undefined, undefined, input.requestId);
    const before = await readRepositorySnapshot(gameRoot);
    if (!before.ok) return failure(before.code, 'publish-preflight', 'Initialize the repository and refresh status', undefined, undefined, undefined, input.requestId);
    if (before.snapshotId !== input.expectedSnapshotId) return failure('version-control-snapshot-stale', 'publish-recheck', 'Refresh the status preview', input.expectedSnapshotId, before.snapshotId, undefined, input.requestId);
    const executable = await resolveRepositoryExecutable();
    const existing = await resolveTagCommit(gameRoot, input.tag);
    if (existing) return failure('version-control-tag-conflict', 'validate-tag', 'Choose another tag', null, existing, undefined, input.requestId);
    const latest = await readLatestRef(gameRoot);
    if (latest && before.head && latest !== before.head) return failure('version-control-partial-publish', 'publish-preflight', 'Recover the untagged latest commit before publishing', latest, before.head, latest, input.requestId);
    const requestId = input.requestId ?? `publish-${Date.now()}-${Math.random().toString(16).slice(2)}`;
    const baseEntry = { schemaVersion: 1 as const, requestId, operation: 'publish', payloadHash: payload, repositoryIdentity: before.repositoryIdentity, beforeHead: before.head };
    await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'accepted' });
    runGit({ executable, cwd: gameRoot, args: ['add', '-A'] });
    const staged = runGit({ executable, cwd: gameRoot, args: ['diff', '--cached', '--name-only'] }).stdout.trim().length > 0;
    let commitIdentity = before.head;
    if (!staged && commitIdentity) {
      const tags = runGit({ executable, cwd: gameRoot, args: ['tag', '--points-at', commitIdentity] }).stdout.trim();
      if (tags) {
        const tag = tags.split('\n')[0]!;
        await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'completed', result: { tag, commitIdentity } });
        return { ok: true, tag, commitIdentity, unchanged: true };
      }
    } else {
      runGit({ executable, cwd: gameRoot, args: ['-c', 'user.name=forgeax-game-host', '-c', 'user.email=game-host@forgeax.local', 'commit', '-m', input.message || `ForgeaX version ${input.tag}`] });
      commitIdentity = runGit({ executable, cwd: gameRoot, args: ['rev-parse', 'HEAD'] }).stdout.trim();
      await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'committed', result: { commitIdentity } });
      const latestUpdate = await compareAndSwapLatest(gameRoot, latest, commitIdentity);
      if (!latestUpdate.ok) {
        await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'partial', result: { commitIdentity }, error: latestUpdate });
        return failure('version-control-partial-publish', 'latest-ref', 'Inspect the untagged commit before retrying', latest, latestUpdate.actual, commitIdentity, requestId);
      }
    }
    try {
      await createAnnotatedTag(gameRoot, input.tag, input.message || `ForgeaX version ${input.tag}`, commitIdentity!);
    } catch (error) {
      await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'tag-failed', result: { commitIdentity }, error: String(error) });
      return failure('version-control-partial-publish', 'tag', 'Inspect the untagged commit before retrying the tag', undefined, undefined, commitIdentity!, requestId);
    }
    const clearLatest = await compareAndSwapLatest(gameRoot, commitIdentity, null);
    if (!clearLatest.ok) {
      await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'partial', result: { tag: input.tag, commitIdentity }, error: clearLatest });
      return failure('version-control-partial-publish', 'latest-ref-clear', 'Inspect the published tag and latest ref before retrying', commitIdentity, clearLatest.actual, commitIdentity!, requestId);
    }
    await appendJournalEntry(gameRoot, { ...baseEntry, stage: 'completed', result: { tag: input.tag, commitIdentity } });
    return { ok: true, tag: input.tag, commitIdentity: commitIdentity! };
  });
}
