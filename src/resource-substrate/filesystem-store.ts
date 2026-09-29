/**
 * Durable ResourceStore backed by immutable blobs, manifests, terminal records,
 * prepared records, and one atomically replaced HEAD file.
 */
import { createHash, randomUUID } from 'node:crypto';
import {
  access,
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  lstat,
  link,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  createResourceError,
  type ResourceId,
  type ResourceMutationIdentity,
  type ResourceMutationRecord,
  type ResourceResult,
  type ResourceRevision,
  type ResourceRevisionInfo,
  type ResourceSnapshot,
  type ResourceTrashEntry,
} from './contract';
import { createInitialManifest, readManifestSnapshot } from './manifest';
import {
  classifyPreparedRecovery,
  classifyPreparedRecoveryWithLineage,
  recoveryRequiredError,
} from './recovery';
import type {
  FilesystemResourceStore,
  FilesystemStoreFailpoint,
  ResourceStoreOperation,
} from './storage';
import { createWriterLease, type WriterLeaseHandle } from './writer-lease';

export interface FilesystemStoreOptions {
  readonly directory: string;
  readonly crashAt?: string;
  readonly afterPreparedRecoveryDetectedForTest?: () => void | Promise<void>;
  readonly beforeInternalLeaseReleaseForTest?: () => void | Promise<void>;
  readonly beforeTerminalWriteForTest?: (identity: string) => void | Promise<void>;
}

interface PersistedManifest {
  readonly revision: string;
  readonly parentRevision?: string | null;
  readonly mutationIdentity?: string;
  readonly resourceIds?: readonly string[];
  readonly active: Readonly<Record<string, string>>;
  readonly trash: readonly PersistedTrashEntry[];
}

interface PersistedTrashEntry {
  readonly resourceId: string;
  readonly digest: string;
  readonly mutationIdentity: string;
  readonly revision: string;
}

interface PreparedRecord {
  readonly identity: string;
  readonly requestDigest: string;
  readonly beforeRevision: string;
  readonly afterRevision: string;
  readonly manifestRevision: string;
  readonly record: ResourceMutationRecord;
}

interface Fault {
  readonly remaining: number | null;
  readonly reason: string;
}

interface DurableLayout {
  readonly rootId: string;
  readonly stateDirectory: string;
  readonly blobsDirectory: string;
  readonly revisionsDirectory: string;
  readonly mutationsDirectory: string;
  readonly preparedDirectory: string;
}

export function createFilesystemResourceStore(
  options: FilesystemStoreOptions,
): FilesystemResourceStore & {
  readRevision(
    rootId: string,
    revision: ResourceRevision,
  ): Promise<ResourceResult<ResourceRevisionInfo | null>>;
} {
  const stateDirectory = resolve(options.directory);
  const rootsDirectory = join(stateDirectory, 'roots');
  const faults = new Map<FilesystemStoreFailpoint, Fault>();

  function layoutFor(rootId: string): DurableLayout {
    const validatedRootId = validateRootId(rootId);
    const rootDirectory = join(rootsDirectory, `root-${digest(validatedRootId)}`);
    return {
      rootId: validatedRootId,
      stateDirectory: rootDirectory,
      blobsDirectory: join(rootDirectory, 'blobs'),
      revisionsDirectory: join(rootDirectory, 'revisions'),
      mutationsDirectory: join(rootDirectory, 'mutations'),
      preparedDirectory: join(rootDirectory, 'prepared'),
    };
  }

  async function initialize(layout: DurableLayout): Promise<ResourceResult<void>> {
    try {
      await mkdir(stateDirectory, { recursive: true });
      await assertStateDirectory();
      await mkdir(rootsDirectory, { recursive: true });
      await assertControlEntry(rootsDirectory);
      await mkdir(layout.stateDirectory, { recursive: true });
      await assertControlEntry(layout.stateDirectory);
      await mkdir(layout.blobsDirectory, { recursive: true });
      await mkdir(layout.revisionsDirectory, { recursive: true });
      await mkdir(layout.mutationsDirectory, { recursive: true });
      await mkdir(layout.preparedDirectory, { recursive: true });
      await assertControlDirectories(layout);
      const headPath = join(layout.stateDirectory, 'HEAD');
      if (!(await exists(headPath))) {
        const bootstrap = await createWriterLease({
          directory: layout.stateDirectory,
          waitForActiveOwner: true,
          isPreparedStateDeterminate: () => preparedStateIsDeterminate(layout),
        }).acquire();
        if (!bootstrap.ok) return bootstrap;
        let bootstrapResult: ResourceResult<void>;
        try {
          if (await exists(headPath)) {
            bootstrapResult = { ok: true, value: undefined };
          } else {
            const initial = createInitialManifest('revision-0' as ResourceSnapshot['revision']);
            const initialPath = join(layout.revisionsDirectory, 'revision-0.json');
            const initialBytes = serializeManifest(initial);
            const revisionEntries = (await readdir(layout.revisionsDirectory)).filter((entry) => entry !== 'revision-0.json');
            const preparedEntries = await readdir(layout.preparedDirectory);
            const mutationEntries = await readdir(layout.mutationsDirectory);
            if (revisionEntries.length > 0 || preparedEntries.some((entry) => entry.endsWith('.json')) || mutationEntries.some((entry) => entry.endsWith('.json'))) {
              throw recoveryException('HEAD is missing while the root contains existing history');
            }
            if (await exists(initialPath)) {
              const existing = await readFile(initialPath, 'utf8');
              try { parseManifest(existing); } catch { throw recoveryException('existing revision-0 manifest is invalid'); }
              if (existing !== initialBytes) throw recoveryException('existing revision-0 manifest conflicts with the initial state');
            } else {
              try { await atomicCreate(initialPath, initialBytes); }
              catch (error) {
                if (!(await exists(initialPath))) throw error;
                const existing = await readFile(initialPath, 'utf8');
                if (existing !== initialBytes) throw recoveryException('concurrent revision-0 initialization conflicts');
              }
            }
            const initialHead = `${initial.revision}\n`;
            try { await atomicCreate(headPath, initialHead); }
            catch (error) {
              if (!(await exists(headPath))) throw error;
              const existingHead = await readFile(headPath, 'utf8');
              if (existingHead !== initialHead) throw recoveryException('concurrent HEAD initialization conflicts');
            }
            bootstrapResult = { ok: true, value: undefined };
          }
        } catch (error) {
          bootstrapResult = failure('readSnapshot', error);
        }
        return finishLease(bootstrap.value, bootstrapResult);
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('readSnapshot', error);
    }
  }

  async function readSnapshot(rootId: string): Promise<ResourceResult<ResourceSnapshot>> {
    try {
      const layout = layoutFor(rootId);
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      const recovered = await recoverPreparedIfNeeded(layout, 'readSnapshot');
      if (!recovered.ok) return recovered;
      const revision = await readHead(layout);
      return await readManifest(layout, revision);
    } catch (error) {
      return failure('readSnapshot', error);
    }
  }

  async function readSnapshotAt(
    rootId: string,
    revision: string,
  ): Promise<ResourceResult<ResourceSnapshot>> {
    try {
      const layout = layoutFor(rootId);
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      return await readManifest(layout, revision);
    } catch (error) {
      return failure('readSnapshot', error);
    }
  }

  async function readRevision(
    rootId: string,
    revision: ResourceRevision,
  ): Promise<ResourceResult<ResourceRevisionInfo | null>> {
    try {
      const layout = layoutFor(rootId);
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      if (!/^[A-Za-z0-9._-]+$/.test(revision)) return { ok: true, value: null };
      const path = join(layout.revisionsDirectory, `${revision}.json`);
      if (!(await exists(path))) return { ok: true, value: null };
      await assertControlFile(path);
      let persisted: PersistedManifest;
      try { persisted = parseManifest(await readFile(path, 'utf8')); }
      catch { throw recoveryException('revision manifest is invalid'); }
      if (persisted.revision !== revision) throw recoveryException('revision manifest does not match its path');
      return {
        ok: true,
        value: {
          revision: persisted.revision as ResourceRevision,
          parentRevision: (persisted.parentRevision ?? null) as ResourceRevision | null,
          mutationIdentity: persisted.mutationIdentity as ResourceMutationIdentity | undefined,
          resourceIds: (persisted.resourceIds ?? []) as ResourceId[],
        },
      };
    } catch (error) {
      return failure('readSnapshot', error);
    }
  }

  async function readMutation(
    rootId: string,
    identity: ResourceMutationIdentity,
  ): Promise<ResourceResult<ResourceMutationRecord | null>> {
    try {
      const layout = layoutFor(rootId);
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      const recovered = await recoverPreparedIfNeeded(layout, 'readMutation');
      if (!recovered.ok) return recovered;
      const path = join(layout.mutationsDirectory, `${digest(identity)}.json`);
      if (!(await exists(path))) return { ok: true, value: null };
      await assertControlFile(path);
      try {
        const parsed = parseRecord(await readFile(path, 'utf8'));
        if (parsed.identity !== String(identity) || parsed.result.identity !== parsed.identity) throw recoveryException(`terminal record ${identity} identity linkage is invalid`);
        return { ok: true, value: parsed };
      } catch (error) {
        if (error && typeof error === 'object' && 'resourceError' in error) throw error;
        throw recoveryException(`terminal record ${identity} is invalid`);
      }
    } catch (error) {
      return failure('readMutation', error);
    }
  }

  async function writeSnapshot(
    rootId: string,
    snapshot: ResourceSnapshot,
  ): Promise<ResourceResult<void>> {
    let layout: DurableLayout;
    let stableSnapshot: ResourceSnapshot;
    try {
      stableSnapshot = captureSnapshotInput(snapshot);
      layout = layoutFor(rootId);
    } catch (error) {
      return failure('writeSnapshot', error);
    }
    const lease = await acquireInternalLease(layout);
    if (!lease.ok) return lease;
    let result: ResourceResult<void>;
    try {
      const ready = await initialize(layout);
      if (!ready.ok) result = ready;
      else {
        const recovered = await recoverPreparedLocked(layout);
        if (!recovered.ok) result = recovered;
        else {
          const persisted = await persistManifest(layout, stableSnapshot);
          if (!persisted.ok) result = persisted;
          else {
            await replaceHead(layout, stableSnapshot.revision);
            result = { ok: true, value: undefined };
          }
        }
      }
    } catch (error) {
      result = failure('writeSnapshot', error);
    }
    return finishLease(lease.value, result!);
  }

  async function writeMutation(
    rootId: string,
    record: ResourceMutationRecord,
  ): Promise<ResourceResult<void>> {
    let layout: DurableLayout;
    let stableRecord: ResourceMutationRecord;
    try {
      stableRecord = captureMutationRecordInput(record);
      layout = layoutFor(rootId);
    } catch (error) {
      return failure('writeMutation', error);
    }
    const lease = await acquireInternalLease(layout);
    if (!lease.ok) return lease;
    let result: ResourceResult<void>;
    try {
      const ready = await initialize(layout);
      if (!ready.ok) result = ready;
      else {
        const recovered = await recoverPreparedLocked(layout);
        if (!recovered.ok) result = recovered;
        else {
          const written = await writeTerminal(layout, stableRecord);
          result = written;
        }
      }
    } catch (error) {
      result = failure('writeMutation', error);
    }
    return finishLease(lease.value, result!);
  }

  async function commitMutation(
    rootId: string,
    snapshot: ResourceSnapshot,
    record: ResourceMutationRecord,
  ): Promise<ResourceResult<void>> {
    let layout: DurableLayout;
    let stableSnapshot: ResourceSnapshot;
    let stableRecord: ResourceMutationRecord;
    try {
      stableSnapshot = captureSnapshotInput(snapshot);
      stableRecord = captureMutationRecordInput(record);
      if (stableSnapshot.revision !== stableRecord.result.afterRevision) {
        throw recoveryException('commit snapshot and mutation record linkage is invalid');
      }
      layout = layoutFor(rootId);
    } catch (error) {
      return failure('commitMutation', error);
    }
    const lease = await acquireInternalLease(layout);
    if (!lease.ok) return lease;
    let resultFromCommit: ResourceResult<void>;
    try {
      const ready = await initialize(layout);
      if (!ready.ok) {
        resultFromCommit = ready;
      } else {
        const recovered = await recoverPreparedLocked(layout);
        if (!recovered.ok) {
          resultFromCommit = recovered;
        } else {
          const existing = await readExistingRecord(layout, stableRecord.identity);
          if (existing) {
            if (existing.requestDigest !== stableRecord.requestDigest) {
              resultFromCommit = { ok: false, error: createResourceError('identity-conflict', { mutationIdentity: stableRecord.identity }) };
            } else if (serializeRecord(existing) !== serializeRecord(stableRecord)) {
              resultFromCommit = recoveryFailure(`terminal record ${stableRecord.identity} conflicts with the requested result`);
            } else {
              resultFromCommit = { ok: true, value: undefined };
            }
          } else {
            const currentRevision = await readHead(layout);
            if (currentRevision !== stableRecord.result.beforeRevision) {
              resultFromCommit = {
                ok: false,
                error: createResourceError('stale-revision', {
                  expected: stableRecord.result.beforeRevision,
                  actual: currentRevision,
                }),
              };
            } else if (!stableRecord.result.changed) {
              resultFromCommit = await writeTerminal(layout, stableRecord);
            } else {
              const persisted = await persistManifest(layout, stableSnapshot, stableRecord);
              if (!persisted.ok) {
                resultFromCommit = persisted;
              } else {
                const prepared: PreparedRecord = {
                  identity: stableRecord.identity,
                  requestDigest: stableRecord.requestDigest,
                  beforeRevision: stableRecord.result.beforeRevision,
                  afterRevision: stableRecord.result.afterRevision,
                  manifestRevision: stableSnapshot.revision,
                  record: stableRecord,
                };
                await writePrepared(layout, prepared);
                await replaceHead(layout, stableSnapshot.revision);
                const terminal = await writeTerminal(layout, stableRecord);
                if (!terminal.ok) {
                  resultFromCommit = terminal;
                } else {
                  try {
                    trigger('cleanup');
                    await rm(join(layout.preparedDirectory, `${digest(prepared.identity)}.json`), { force: true });
                  } catch {
                    // Cleanup is advisory; HEAD and the terminal record are authoritative.
                  }
                  resultFromCommit = { ok: true, value: undefined };
                }
              }
            }
          }
        }
      }
    } catch (error) {
      resultFromCommit = failure('commitMutation', error);
    }
    return finishLease(lease.value, resultFromCommit!);
  }

  async function readManifest(
    layout: DurableLayout,
    revision: string,
  ): Promise<ResourceResult<ResourceSnapshot>> {
    if (!/^[A-Za-z0-9._-]+$/.test(revision)) {
      return failure('readSnapshot', new Error('invalid revision token'));
    }
    const path = join(layout.revisionsDirectory, `${revision}.json`);
    await assertControlFile(path);
    let persisted: PersistedManifest;
    try { persisted = parseManifest(await readFile(path, 'utf8')); }
    catch { throw recoveryException('revision manifest is invalid'); }
      if (persisted.revision !== String(revision)) throw recoveryException('revision manifest does not match its path');
    const active: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
    for (const [resourceId, blobDigest] of Object.entries(persisted.active)) {
      active[resourceId] = await readBlob(layout, blobDigest);
    }
    const trash: ResourceTrashEntry[] = [];
    for (const entry of persisted.trash) {
      trash.push({
        resourceId: entry.resourceId as ResourceTrashEntry['resourceId'],
        bytes: await readBlob(layout, entry.digest),
        mutationIdentity: entry.mutationIdentity as ResourceTrashEntry['mutationIdentity'],
        revision: entry.revision as ResourceTrashEntry['revision'],
      });
    }
    return {
      ok: true,
      value: readManifestSnapshot({
        revision: persisted.revision as ResourceSnapshot['revision'],
        active,
        trash,
      }),
    };
  }

  async function persistManifest(
    layout: DurableLayout,
    snapshot: ResourceSnapshot,
    record?: ResourceMutationRecord,
  ): Promise<ResourceResult<void>> {
    try {
      const stableSnapshot = captureSnapshotInput(snapshot);
      const stableRecord = record ? captureMutationRecordInput(record) : undefined;
      const active: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const [resourceId, bytes] of Object.entries(stableSnapshot.active)) {
        const blobDigest = digestBytes(bytes);
        active[resourceId] = blobDigest;
      }
      const trash: PersistedTrashEntry[] = [];
      for (const entry of stableSnapshot.trash) {
        trash.push({
          resourceId: entry.resourceId,
          digest: digestBytes(entry.bytes),
          mutationIdentity: entry.mutationIdentity,
          revision: entry.revision,
        });
      }
      const path = join(layout.revisionsDirectory, `${stableSnapshot.revision}.json`);
      await assertControlFile(path);
      const serialized = stableRecord
        ? serializeManifest({
            revision: stableSnapshot.revision,
            parentRevision: stableRecord.result.beforeRevision,
            mutationIdentity: stableRecord.identity,
            resourceIds: stableRecord.resourceIds ?? [],
            active,
            trash,
          })
        : serializeManifest({ revision: stableSnapshot.revision, parentRevision: null, resourceIds: [], active, trash } as PersistedManifest);
      parseManifest(serialized);
      if (await exists(path)) {
        const existingRaw = await readFile(path, 'utf8');
        let existing: PersistedManifest;
        try { existing = parseManifest(existingRaw); } catch { return recoveryFailure(`revision ${stableSnapshot.revision} has invalid existing bytes`); }
        try { await validateManifestBlobs(layout, existing); } catch { return recoveryFailure(`revision ${stableSnapshot.revision} references invalid blobs`); }
        if (existingRaw !== serialized) {
          return recoveryFailure(`revision ${stableSnapshot.revision} already exists with different bytes`);
        }
        return { ok: true, value: undefined };
      }
      for (const [resourceId, bytes] of Object.entries(stableSnapshot.active)) {
        await persistBlob(layout, bytes);
        active[resourceId] = digestBytes(bytes);
      }
      for (const entry of stableSnapshot.trash) await persistBlob(layout, entry.bytes);
      trigger('manifest-write');
      await atomicWrite(path, serialized);
      trigger('manifest-fsync');
      await fsyncFile(path);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('writeSnapshot', error);
    }
  }

  async function persistBlob(layout: DurableLayout, bytes: Uint8Array): Promise<string> {
    const blobDigest = digestBytes(bytes);
    const path = join(layout.blobsDirectory, blobDigest);
    await assertControlFile(path);
    if (!(await exists(path))) {
      trigger('blob-write');
      await atomicWrite(path, bytes);
      trigger('blob-fsync');
      await fsyncFile(path);
    } else {
      const existing = new Uint8Array(await readFile(path));
      if (digestBytes(existing) !== blobDigest) throw recoveryException(`blob ${blobDigest} content digest mismatch`);
    }
    return blobDigest;
  }

  async function readBlob(layout: DurableLayout, blobDigest: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(blobDigest)) throw new Error('invalid blob digest');
    const path = join(layout.blobsDirectory, blobDigest);
    await assertControlFile(path);
    const bytes = new Uint8Array(await readFile(path));
    if (digestBytes(bytes) !== blobDigest) throw recoveryException(`blob ${blobDigest} content digest mismatch`);
    return bytes;
  }

  async function validateManifestBlobs(layout: DurableLayout, manifest: PersistedManifest): Promise<void> {
    for (const digestValue of Object.values(manifest.active)) await readBlob(layout, digestValue);
    for (const entry of manifest.trash) await readBlob(layout, entry.digest);
  }

  async function writePrepared(layout: DurableLayout, prepared: PreparedRecord): Promise<void> {
    const stableRecord = captureMutationRecordInput(prepared.record);
    const stablePrepared: PreparedRecord = {
      identity: prepared.identity,
      requestDigest: prepared.requestDigest,
      beforeRevision: prepared.beforeRevision,
      afterRevision: prepared.afterRevision,
      manifestRevision: prepared.manifestRevision,
      record: stableRecord,
    };
    const path = join(layout.preparedDirectory, `${digest(stablePrepared.identity)}.json`);
    await assertControlFile(path);
    const serialized = serializePrepared(stablePrepared);
    parsePrepared(serialized);
    if (await exists(path)) {
      const existing = await readFile(path, 'utf8');
      try { parsePrepared(existing); } catch { throw recoveryException('prepared record has invalid existing bytes'); }
      if (existing !== serialized) throw recoveryException('prepared record already exists with different bytes');
      return;
    }
    trigger('prepared-write');
    await atomicWrite(path, serialized);
    trigger('prepared-fsync');
    await fsyncFile(path);
  }

  async function writeTerminal(
    layout: DurableLayout,
    record: ResourceMutationRecord,
  ): Promise<ResourceResult<void>> {
    const stableRecord = captureMutationRecordInput(record);
    const path = join(layout.mutationsDirectory, `${digest(stableRecord.identity)}.json`);
    await assertControlFile(path);
    const serialized = serializeRecord(stableRecord);
    parseRecord(serialized);
    if (await exists(path)) {
      const existing = await readFile(path, 'utf8');
      try { parseRecord(existing); } catch { return recoveryFailure(`terminal record ${stableRecord.identity} has invalid existing bytes`); }
      if (existing !== serialized) return recoveryFailure(`terminal record ${stableRecord.identity} conflicts with existing bytes`);
      return { ok: true, value: undefined };
    }
    if (options.beforeTerminalWriteForTest) await options.beforeTerminalWriteForTest(stableRecord.identity);
    trigger('terminal-write');
    await atomicWrite(path, serialized);
    trigger('terminal-fsync');
    await fsyncFile(path);
    return { ok: true, value: undefined };
  }

  async function replaceHead(layout: DurableLayout, revision: string): Promise<void> {
    if (!isRevisionToken(revision)) throw recoveryException('cannot replace HEAD with an invalid revision token');
    const path = join(layout.stateDirectory, 'HEAD');
    await assertControlFile(path);
    trigger('head-replace');
    await atomicWrite(path, `${revision}\n`);
    trigger('after-head-replace');
    trigger('head-fsync');
    await fsyncFile(path);
  }

  async function preparedEntries(layout: DurableLayout): Promise<string[]> {
    const entries = await readdir(layout.preparedDirectory);
    return entries.filter((entry) => entry.endsWith('.json'));
  }

  async function recoverPreparedIfNeeded(
    layout: DurableLayout,
    operation: ResourceStoreOperation,
  ): Promise<ResourceResult<void>> {
    try {
      const entries = await preparedEntries(layout);
      if (entries.length === 0) return { ok: true, value: undefined };
      if (options.afterPreparedRecoveryDetectedForTest) {
        await options.afterPreparedRecoveryDetectedForTest();
      }
      const lease = await acquireInternalLease(layout);
      if (!lease.ok) return lease;
      let result: ResourceResult<void>;
      try {
        result = await recoverPreparedLocked(layout);
      } catch (error) {
        result = failure(operation, error);
      }
      return finishLease(lease.value, result);
    } catch (error) {
      return failure(operation, error);
    }
  }

  async function recoverPreparedLocked(layout: DurableLayout): Promise<ResourceResult<void>> {
    try {
      const entries = await preparedEntries(layout);
      if (entries.length === 0) return { ok: true, value: undefined };
      if (entries.length > 1) return recoveryFailure('multiple prepared records require manual recovery');
      const path = join(layout.preparedDirectory, entries[0]!);
      await assertControlFile(path);
      const prepared = parsePrepared(await readFile(path, 'utf8'));
      if (entries[0] !== `${digest(prepared.identity)}.json`) return recoveryFailure('prepared filename does not match its identity');
      await validatePrepared(layout, prepared);
      const currentRevision = await readHead(layout);
      const decision = await classifyPreparedRecoveryWithLineage({
        beforeRevision: prepared.beforeRevision,
        currentRevision,
        afterRevision: prepared.afterRevision,
        readManifest: async (revision) => readPersistedManifest(layout, revision),
      });
      if (!decision.ok) return decision;
      const existing = await readExistingRecord(layout, prepared.record.identity);
      if (decision.value === 'keep-before') {
        if (existing) return recoveryFailure('terminal exists while HEAD is still before prepared mutation');
      } else if (existing) {
        if (serializeRecord(existing) !== serializeRecord(prepared.record)) {
          return recoveryFailure('existing terminal record does not match prepared mutation');
        }
      } else {
        const terminal = await writeTerminal(layout, prepared.record);
        if (!terminal.ok) return terminal;
      }
      await rm(path, { force: true });
      return { ok: true, value: undefined };
    } catch (error) {
      if (error && typeof error === 'object' && 'resourceError' in error) return failure('readSnapshot', error);
      return recoveryFailure(`prepared recovery validation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function validatePrepared(layout: DurableLayout, prepared: PreparedRecord): Promise<void> {
    if (prepared.manifestRevision !== prepared.afterRevision) {
      throw recoveryException('prepared manifest revision does not match after revision');
    }
    const result = prepared.record.result;
    if (
      prepared.record.identity !== prepared.identity ||
      result.identity !== prepared.identity ||
      prepared.record.requestDigest !== prepared.requestDigest ||
      result.beforeRevision !== prepared.beforeRevision ||
      result.afterRevision !== prepared.afterRevision ||
      typeof result.changed !== 'boolean'
    ) throw recoveryException('prepared record linkage is invalid');
    const after = await readPersistedManifest(layout, prepared.afterRevision);
    await validateManifestBlobs(layout, after);
    if (
      after.parentRevision !== prepared.beforeRevision ||
      after.mutationIdentity !== prepared.identity ||
      JSON.stringify(after.resourceIds ?? []) !== JSON.stringify(prepared.record.resourceIds ?? [])
    ) throw recoveryException('prepared after manifest linkage is invalid');
  }

  async function readPersistedManifest(layout: DurableLayout, revision: string): Promise<PersistedManifest> {
    if (!/^[A-Za-z0-9._-]+$/.test(revision)) throw recoveryException('invalid revision token in lineage');
    const path = join(layout.revisionsDirectory, `${revision}.json`);
    await assertControlFile(path);
    let parsed: PersistedManifest;
    try { parsed = parseManifest(await readFile(path, 'utf8')); }
    catch { throw recoveryException('lineage manifest is invalid'); }
    if (parsed.revision !== revision) throw recoveryException('lineage manifest revision does not match its path');
    return parsed;
  }

  async function readExistingRecord(
    layout: DurableLayout,
    identity: ResourceMutationIdentity | string,
  ): Promise<ResourceMutationRecord | null> {
    const path = join(layout.mutationsDirectory, `${digest(identity)}.json`);
    if (!(await exists(path))) return null;
    await assertControlFile(path);
    try {
      const parsed = parseRecord(await readFile(path, 'utf8'));
      if (parsed.identity !== String(identity) || parsed.result.identity !== parsed.identity) throw recoveryException(`terminal record ${identity} identity linkage is invalid`);
      return parsed;
    } catch (error) {
      if (error && typeof error === 'object' && 'resourceError' in error) throw error;
      throw recoveryException(`terminal record ${identity} is invalid`);
    }
  }

  async function readHead(layout: DurableLayout): Promise<string> {
    const path = join(layout.stateDirectory, 'HEAD');
    await assertControlFile(path);
    const raw = await readFile(path, 'utf8');
    if (!raw.endsWith('\n') || raw.slice(0, -1).includes('\n')) throw recoveryException('HEAD is not in canonical encoding');
    const revision = raw.slice(0, -1);
    if (!isRevisionToken(revision)) throw recoveryException('HEAD contains an invalid revision token');
    return revision;
  }

  async function acquireInternalLease(layout: DurableLayout): Promise<ResourceResult<WriterLeaseHandle>> {
    const ready = await initialize(layout);
    if (!ready.ok) return ready;
    return createWriterLease({
      directory: layout.stateDirectory,
      waitForActiveOwner: true,
      isPreparedStateDeterminate: () => preparedStateIsDeterminate(layout),
    }).acquire();
  }

  async function finishLease<T>(
    owner: WriterLeaseHandle,
    primary: ResourceResult<T>,
  ): Promise<ResourceResult<T>> {
    let hookError: unknown;
    let released: ResourceResult<void>;
    try {
      if (options.beforeInternalLeaseReleaseForTest) await options.beforeInternalLeaseReleaseForTest();
    } catch (error) {
      hookError = error;
    }
    try { released = await owner.release(); }
    catch (error) { released = failure('writeSnapshot', error); }
    if (hookError && released.ok) released = failure('writeSnapshot', hookError);
    if (released.ok) return primary;
    if (primary.ok) return { ok: false, error: released.error };
    return {
      ok: false,
      error: createResourceError('storage-failure', {
        storageReason: JSON.stringify({ primary: primary.error, release: released.error }),
        retryable: false,
      }),
    };
  }

  async function preparedStateIsDeterminate(layout: DurableLayout): Promise<boolean> {
    try {
      const entries = await readdir(layout.preparedDirectory);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const prepared = JSON.parse(
          await readFile(join(layout.preparedDirectory, entry), 'utf8'),
        ) as PreparedRecord;
        if (!prepared.beforeRevision || !prepared.afterRevision || !prepared.record) return false;
      }
      return true;
    } catch {
      return false;
    }
  }

  async function assertStateDirectory(): Promise<void> {
    const info = await lstat(stateDirectory);
    if (info.isSymbolicLink()) throw confinementError('state directory is a symlink');
    const real = await realpath(stateDirectory);
    if (!isAbsolute(real)) throw confinementError('state directory is not absolute');
  }

  async function assertControlDirectories(layout: DurableLayout): Promise<void> {
    for (const path of [
      layout.stateDirectory,
      layout.blobsDirectory,
      layout.revisionsDirectory,
      layout.mutationsDirectory,
      layout.preparedDirectory,
    ]) {
      await assertControlEntry(path);
    }
  }

  async function assertControlEntry(path: string): Promise<void> {
    if (!(await exists(path))) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw confinementError(`control entry is a symlink: ${path}`);
    const root = await realpath(stateDirectory);
    const target = await realpath(path);
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw confinementError(`control entry escapes state directory: ${path}`);
    }
  }

  async function assertControlFile(path: string): Promise<void> {
    if (!(await exists(path))) return;
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw confinementError(`control entry is a symlink: ${path}`);
    const root = await realpath(stateDirectory);
    const target = await realpath(path);
    if (target !== root && !target.startsWith(`${root}/`)) {
      throw confinementError(`control entry escapes state directory: ${path}`);
    }
  }

  function confinementError(reason: string): Error & { readonly code: 'root-confinement-violation' } {
    const error = new Error(reason) as Error & { readonly code: 'root-confinement-violation' };
    Object.defineProperty(error, 'code', { value: 'root-confinement-violation' });
    return error;
  }

  function failure(operation: ResourceStoreOperation, error: unknown): ResourceResult<never> {
    if (error && typeof error === 'object' && 'resourceError' in error) {
      return { ok: false, error: (error as { resourceError: ReturnType<typeof recoveryRequiredError> }).resourceError };
    }
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'root-confinement-violation') {
      return {
        ok: false,
        error: createResourceError('root-confinement-violation', {
          storageReason: error instanceof Error ? error.message : String(error),
          retryable: false,
        }),
      };
    }
    return {
      ok: false,
      error: createResourceError('storage-failure', {
        storageReason: `${operation}: ${error instanceof Error ? error.message : String(error)}`,
        retryable: true,
      }),
    };
  }

  function trigger(failpoint: FilesystemStoreFailpoint): void {
    const fault = faults.get(failpoint);
    if (options.crashAt === failpoint) process.exit(77);
    if (!fault) return;
    if (fault.remaining !== null) {
      if (fault.remaining <= 1) faults.delete(failpoint);
      else faults.set(failpoint, { ...fault, remaining: fault.remaining - 1 });
    }
    throw new Error(`${failpoint}: ${fault.reason}`);
  }

  return {
    stateDirectory,
    readSnapshot,
    readSnapshotAt,
    readRevision,
    readMutation,
    writeSnapshot,
    writeMutation,
    commitMutation,
    failNext(failpoint, reason = 'injected failure') {
      faults.set(failpoint, { remaining: 1, reason });
    },
    failAlways(failpoint, reason = 'injected failure') {
      faults.set(failpoint, { remaining: null, reason });
    },
    clearFaults() {
      faults.clear();
    },
  };
}

function assertSnapshotInput(snapshot: ResourceSnapshot): void {
  if (!isPlainRecord(snapshot) || !hasExactEnumerableKeys(snapshot, ['revision', 'active', 'trash'])) {
    throw recoveryException('snapshot input has an invalid shape');
  }
  if (typeof snapshot.revision !== 'string' || !isRevisionToken(snapshot.revision)) {
    throw recoveryException('snapshot revision is not a safe revision token');
  }
  if (!isPlainRecord(snapshot.active) || Reflect.ownKeys(snapshot.active).some((key) => {
    if (typeof key !== 'string') return true;
    const descriptor = Object.getOwnPropertyDescriptor(snapshot.active, key);
    return !descriptor?.enumerable || !('value' in descriptor);
  })) {
    throw recoveryException('snapshot active state must be a plain enumerable record');
  }
  for (const bytes of Object.values(snapshot.active)) {
    if (!(bytes instanceof Uint8Array)) throw recoveryException('snapshot active bytes must be Uint8Array values');
  }
  if (!isDenseArray(snapshot.trash)) {
    throw recoveryException('snapshot trash must be a dense array');
  }
  for (const entry of snapshot.trash) {
    if (!isPlainRecord(entry) || !hasExactEnumerableKeys(entry, ['resourceId', 'bytes', 'mutationIdentity', 'revision'])) {
      throw recoveryException('snapshot trash entry has an invalid shape');
    }
    if (
      typeof entry.resourceId !== 'string' ||
      !(entry.bytes instanceof Uint8Array) ||
      typeof entry.mutationIdentity !== 'string' ||
      typeof entry.revision !== 'string' ||
      !isRevisionToken(entry.revision)
    ) {
      throw recoveryException('snapshot trash entry has invalid fields');
    }
  }
}

function captureSnapshotInput(snapshot: ResourceSnapshot): ResourceSnapshot {
  assertSnapshotInput(snapshot);
  const active: Record<string, Uint8Array> = Object.create(null) as Record<string, Uint8Array>;
  for (const [resourceId, bytes] of Object.entries(snapshot.active)) {
    active[resourceId] = new Uint8Array(bytes);
  }
  return {
    revision: snapshot.revision,
    active,
    trash: snapshot.trash.map((entry) => ({
      resourceId: entry.resourceId,
      bytes: new Uint8Array(entry.bytes),
      mutationIdentity: entry.mutationIdentity,
      revision: entry.revision,
    })),
  };
}

function assertMutationRecordInput(record: ResourceMutationRecord): void {
  if (!isPlainRecord(record)) throw recoveryException('mutation record input must be a plain record');
  const recordKeys = 'resourceIds' in record
    ? ['identity', 'requestDigest', 'result', 'resourceIds']
    : ['identity', 'requestDigest', 'result'];
  if (!hasExactEnumerableKeys(record, recordKeys) || typeof record.identity !== 'string' || typeof record.requestDigest !== 'string' || !isPlainRecord(record.result)) {
    throw recoveryException('mutation record input has an invalid shape');
  }
  if (!hasExactEnumerableKeys(record.result, ['identity', 'beforeRevision', 'afterRevision', 'changed'])) {
    throw recoveryException('mutation result input has an invalid shape');
  }
  if (
    typeof record.result.identity !== 'string' ||
    record.result.identity !== record.identity ||
    typeof record.result.beforeRevision !== 'string' ||
    !isRevisionToken(record.result.beforeRevision) ||
    typeof record.result.afterRevision !== 'string' ||
    !isRevisionToken(record.result.afterRevision) ||
    typeof record.result.changed !== 'boolean' ||
    record.result.changed !== (record.result.beforeRevision !== record.result.afterRevision)
  ) {
    throw recoveryException('mutation record identity or revision linkage is invalid');
  }
  if ('resourceIds' in record && (!isDenseStringArray(record.resourceIds))) {
    throw recoveryException('mutation record resource ids must be a dense string array');
  }
  parseRecord(serializeRecord(record));
}

function captureMutationRecordInput(record: ResourceMutationRecord): ResourceMutationRecord {
  assertMutationRecordInput(record);
  const captured: ResourceMutationRecord = {
    identity: record.identity,
    requestDigest: record.requestDigest,
    result: {
      identity: record.result.identity,
      beforeRevision: record.result.beforeRevision,
      afterRevision: record.result.afterRevision,
      changed: record.result.changed,
    },
    ...('resourceIds' in record ? { resourceIds: [...record.resourceIds!] } : {}),
  };
  parseRecord(serializeRecord(captured));
  return captured;
}

function hasExactEnumerableKeys(value: object, expected: readonly string[]): boolean {
  const keys = Reflect.ownKeys(value);
  return keys.length === expected.length && expected.every((key) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor?.enumerable === true && 'value' in descriptor;
  });
}

function isDenseStringArray(value: unknown): value is readonly string[] {
  return isDenseArray(value) && value.every((entry) => typeof entry === 'string');
}

function isDenseArray(value: unknown): value is readonly unknown[] {
  if (!Array.isArray(value)) return false;
  const keys = Reflect.ownKeys(value).filter((key) => key !== 'length');
  return keys.length === value.length && keys.every((key, index) => {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return key === String(index) && descriptor?.enumerable === true && 'value' in descriptor;
  });
}

function isPlainRecord(value: unknown): value is Record<string, any> {
  if (!isRecord(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function serializeManifest(snapshot: ResourceSnapshot | PersistedManifest): string {
  const encoded: Record<string, unknown> = { revision: snapshot.revision };
  if ('parentRevision' in snapshot) {
    encoded.parentRevision = snapshot.parentRevision;
    if (snapshot.mutationIdentity !== undefined) encoded.mutationIdentity = snapshot.mutationIdentity;
    if (snapshot.resourceIds !== undefined) encoded.resourceIds = snapshot.resourceIds;
  }
  encoded.active = snapshot.active;
  encoded.trash = snapshot.trash.map((entry) => ({
    resourceId: entry.resourceId,
    digest: 'digest' in entry ? entry.digest : digestBytes(entry.bytes),
    mutationIdentity: entry.mutationIdentity,
    revision: entry.revision,
  }));
  return JSON.stringify(encoded);
}

function parseManifest(value: string): PersistedManifest {
  const parsed = parseExactJson(value, 'revision manifest') as PersistedManifest;
  const allowed = new Set(['revision', 'parentRevision', 'mutationIdentity', 'resourceIds', 'active', 'trash']);
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !allowed.has(key))) throw new Error('invalid revision manifest keys');
  const manifestKeys = Object.keys(parsed);
  const initialShape = manifestKeys.length === 3 && manifestKeys.includes('revision') && manifestKeys.includes('active') && manifestKeys.includes('trash');
  const persistedShape = (manifestKeys.length === 5 || manifestKeys.length === 6) && manifestKeys.includes('parentRevision') && manifestKeys.includes('resourceIds');
  if (!initialShape && !persistedShape) throw new Error('invalid revision manifest shape');
  if (typeof parsed.revision !== 'string' || !isRevisionToken(parsed.revision) || !isRecord(parsed.active) || !Array.isArray(parsed.trash)) {
    throw new Error('invalid revision manifest');
  }
  if ('parentRevision' in parsed && parsed.parentRevision !== null && (typeof parsed.parentRevision !== 'string' || !isRevisionToken(parsed.parentRevision))) throw new Error('invalid manifest parent');
  if ('mutationIdentity' in parsed && typeof parsed.mutationIdentity !== 'string') throw new Error('invalid manifest identity');
  if (initialShape && (parsed.revision !== 'revision-0' || Object.keys(parsed.active).length !== 0 || parsed.trash.length !== 0)) throw new Error('only empty revision-0 may use initial manifest shape');
  if (persistedShape && manifestKeys.length === 5 && parsed.parentRevision !== null) throw new Error('persisted manifest without mutation must have null parent');
  if (persistedShape && manifestKeys.length === 5 && ('mutationIdentity' in parsed || parsed.resourceIds?.length !== 0)) throw new Error('persisted manifest without mutation must have empty metadata');
  if (persistedShape && manifestKeys.length === 6 && (parsed.parentRevision === null || !parsed.mutationIdentity)) throw new Error('persisted mutation manifest linkage is incomplete');
  if ('resourceIds' in parsed && (!Array.isArray(parsed.resourceIds) || parsed.resourceIds.some((id) => typeof id !== 'string'))) throw new Error('invalid manifest resource ids');
  for (const [resourceId, blobDigest] of Object.entries(parsed.active)) {
    if (typeof resourceId !== 'string' || typeof blobDigest !== 'string' || !/^[a-f0-9]{64}$/.test(blobDigest)) throw new Error('invalid manifest active entry');
  }
  for (const entry of parsed.trash) {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['resourceId', 'digest', 'mutationIdentity', 'revision'].includes(key)) || Object.keys(entry).length !== 4 || typeof entry.resourceId !== 'string' || typeof entry.digest !== 'string' || typeof entry.mutationIdentity !== 'string' || typeof entry.revision !== 'string' || !isRevisionToken(entry.revision)) throw new Error('invalid manifest trash entry');
    if (!/^[a-f0-9]{64}$/.test(entry.digest)) throw new Error('invalid manifest trash digest');
  }
  if (serializeManifest(parsed) !== value) throw new Error('non-canonical revision manifest encoding');
  return parsed;
}

function parseRecord(value: string): ResourceMutationRecord {
  const parsed = parseExactJson(value, 'mutation record') as ResourceMutationRecord;
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !['identity', 'requestDigest', 'result', 'resourceIds'].includes(key)) || typeof parsed.identity !== 'string' || typeof parsed.requestDigest !== 'string' || !isRecord(parsed.result)) throw new Error('invalid mutation record');
  if (Object.keys(parsed.result).some((key) => !['identity', 'beforeRevision', 'afterRevision', 'changed'].includes(key))) throw new Error('invalid mutation result');
  if (typeof parsed.result.identity !== 'string' || parsed.identity !== parsed.result.identity || typeof parsed.result.beforeRevision !== 'string' || !isRevisionToken(parsed.result.beforeRevision) || typeof parsed.result.afterRevision !== 'string' || !isRevisionToken(parsed.result.afterRevision) || typeof parsed.result.changed !== 'boolean' || parsed.result.changed !== (parsed.result.beforeRevision !== parsed.result.afterRevision)) throw new Error('invalid mutation result');
  if ('resourceIds' in parsed && (!Array.isArray(parsed.resourceIds) || parsed.resourceIds.some((id) => typeof id !== 'string'))) throw new Error('invalid mutation resource ids');
  if (serializeRecord(parsed) !== value) throw new Error('non-canonical mutation record encoding');
  return parsed;
}

function serializeRecord(record: ResourceMutationRecord): string {
  const result = {
    identity: record.result.identity,
    beforeRevision: record.result.beforeRevision,
    afterRevision: record.result.afterRevision,
    changed: record.result.changed,
  };
  const encoded: Record<string, unknown> = {
    identity: record.identity,
    requestDigest: record.requestDigest,
    result,
  };
  if (record.resourceIds !== undefined) encoded.resourceIds = record.resourceIds;
  return JSON.stringify(encoded);
}

function serializePrepared(prepared: PreparedRecord): string {
  return JSON.stringify({
    identity: prepared.identity,
    requestDigest: prepared.requestDigest,
    beforeRevision: prepared.beforeRevision,
    afterRevision: prepared.afterRevision,
    manifestRevision: prepared.manifestRevision,
    record: JSON.parse(serializeRecord(prepared.record)),
  });
}

function parsePrepared(value: string): PreparedRecord {
  const parsed = parseExactJson(value, 'prepared record') as PreparedRecord;
  if (!isRecord(parsed) || Object.keys(parsed).some((key) => !['identity', 'requestDigest', 'beforeRevision', 'afterRevision', 'manifestRevision', 'record'].includes(key)) || typeof parsed.identity !== 'string' || typeof parsed.requestDigest !== 'string' || typeof parsed.beforeRevision !== 'string' || !isRevisionToken(parsed.beforeRevision) || typeof parsed.afterRevision !== 'string' || !isRevisionToken(parsed.afterRevision) || typeof parsed.manifestRevision !== 'string' || !isRevisionToken(parsed.manifestRevision) || !isRecord(parsed.record)) throw new Error('invalid prepared record');
  parseRecord(JSON.stringify(parsed.record));
  if (serializePrepared(parsed) !== value) throw new Error('non-canonical prepared record encoding');
  return parsed;
}

function parseExactJson(value: string, label: string): unknown {
  let parsed: unknown;
  try {
    assertNoDuplicateKeys(value);
    parsed = JSON.parse(value);
  } catch { throw new Error(`invalid ${label}`); }
  if (!isRecord(parsed) && !Array.isArray(parsed)) throw new Error(`invalid ${label}`);
  return parsed;
}

function assertNoDuplicateKeys(value: string): void {
  let index = 0;
  const whitespace = () => { while (/\s/.test(value[index] ?? '')) index += 1; };
  const string = (): string => {
    const start = index;
    if (value[index++] !== '"') throw new Error('expected string');
    while (index < value.length) {
      const char = value[index++];
      if (char === '\\') index += 1;
      else if (char === '"') return JSON.parse(value.slice(start, index)) as string;
    }
    throw new Error('unterminated string');
  };
  const atom = () => {
    const start = index;
    while (index < value.length && !/[\s,\]}]/.test(value[index]!)) index += 1;
    if (start === index) throw new Error('expected value');
  };
  const parse = () => {
    whitespace();
    if (value[index] === '"') { string(); return; }
    if (value[index] === '{') {
      index += 1;
      const keys = new Set<string>();
      whitespace();
      if (value[index] === '}') { index += 1; return; }
      while (true) {
        whitespace();
        const key = string();
        if (keys.has(key)) throw new Error('duplicate key');
        keys.add(key);
        whitespace();
        if (value[index++] !== ':') throw new Error('expected colon');
        parse();
        whitespace();
        if (value[index] === '}') { index += 1; return; }
        if (value[index++] !== ',') throw new Error('expected comma');
      }
    }
    if (value[index] === '[') {
      index += 1;
      whitespace();
      if (value[index] === ']') { index += 1; return; }
      while (true) {
        parse();
        whitespace();
        if (value[index] === ']') { index += 1; return; }
        if (value[index++] !== ',') throw new Error('expected comma');
      }
    }
    atom();
  };
  parse();
  whitespace();
  if (index !== value.length) throw new Error('trailing data');
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function recoveryFailure(reason: string): ResourceResult<never> {
  return { ok: false, error: recoveryRequiredError(reason) };
}

function recoveryException(reason: string): Error & { readonly resourceError: ReturnType<typeof recoveryRequiredError> } {
  const error = new Error(reason) as Error & { readonly resourceError: ReturnType<typeof recoveryRequiredError> };
  Object.defineProperty(error, 'resourceError', { value: recoveryRequiredError(reason) });
  return error;
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, data, { flag: 'wx' });
  await rename(temporary, path);
}

async function atomicCreate(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, data, { flag: 'wx' });
  await fsyncFile(temporary);
  try {
    await link(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function fsyncFile(path: string): Promise<void> {
  const handle = await open(path, 'r');
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function realpath(path: string): Promise<string> {
  const { realpath: resolveRealpath } = await import('node:fs/promises');
  return resolveRealpath(path);
}

function validateRootId(rootId: string): string {
  if (typeof rootId !== 'string') throw confinementErrorForRoot('root id must be a string');
  if (
    !rootId ||
    rootId !== rootId.trim() ||
    rootId === '.' ||
    rootId === '..' ||
    rootId.includes('\0') ||
    isAbsolute(rootId) ||
    rootId.includes('/') ||
    rootId.includes('\\')
  ) {
    throw confinementErrorForRoot('root id must be a single safe logical segment');
  }
  return rootId;
}

function confinementErrorForRoot(reason: string): Error & { readonly code: 'root-confinement-violation' } {
  const error = new Error(reason) as Error & { readonly code: 'root-confinement-violation' };
  Object.defineProperty(error, 'code', { value: 'root-confinement-violation' });
  return error;
}

function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function digestBytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function isRevisionToken(value: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(value) && value.length > 0;
}
