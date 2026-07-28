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
import { classifyPreparedRecovery } from './recovery';
import type {
  FilesystemResourceStore,
  FilesystemStoreFailpoint,
  ResourceStoreOperation,
} from './storage';
import { createWriterLease, type WriterLeaseHandle } from './writer-lease';

export interface FilesystemStoreOptions {
  readonly directory: string;
  readonly crashAt?: string;
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
        const initial = createInitialManifest('revision-0' as ResourceSnapshot['revision']);
        await writeFile(join(layout.revisionsDirectory, 'revision-0.json'), serializeManifest(initial));
        await atomicWrite(headPath, `${initial.revision}\n`);
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
      const recovered = await recoverPrepared(layout);
      if (!recovered.ok) return recovered;
      const revision = await readHead(layout);
      return readManifest(layout, revision);
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
      return readManifest(layout, revision);
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
      const persisted = parseManifest(await readFile(path, 'utf8'));
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
      const recovered = await recoverPrepared(layout);
      if (!recovered.ok) return recovered;
      const path = join(layout.mutationsDirectory, `${digest(identity)}.json`);
      if (!(await exists(path))) return { ok: true, value: null };
      await assertControlFile(path);
      return { ok: true, value: parseRecord(await readFile(path, 'utf8')) };
    } catch (error) {
      return failure('readMutation', error);
    }
  }

  async function writeSnapshot(
    rootId: string,
    snapshot: ResourceSnapshot,
  ): Promise<ResourceResult<void>> {
    let layout: DurableLayout;
    try {
      layout = layoutFor(rootId);
    } catch (error) {
      return failure('writeSnapshot', error);
    }
    const lease = await acquireInternalLease(layout);
    if (!lease.ok) return lease;
    try {
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      const persisted = await persistManifest(layout, snapshot);
      if (!persisted.ok) return persisted;
      await replaceHead(layout, snapshot.revision);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('writeSnapshot', error);
    } finally {
      await releaseInternalLease(lease.value);
    }
  }

  async function writeMutation(
    rootId: string,
    record: ResourceMutationRecord,
  ): Promise<ResourceResult<void>> {
    try {
      const layout = layoutFor(rootId);
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      await writeTerminal(layout, record);
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('writeMutation', error);
    }
  }

  async function commitMutation(
    rootId: string,
    snapshot: ResourceSnapshot,
    record: ResourceMutationRecord,
  ): Promise<ResourceResult<void>> {
    let layout: DurableLayout;
    try {
      layout = layoutFor(rootId);
    } catch (error) {
      return failure('commitMutation', error);
    }
    const lease = await acquireInternalLease(layout);
    if (!lease.ok) return lease;
    try {
      const ready = await initialize(layout);
      if (!ready.ok) return ready;
      const recovered = await recoverPrepared(layout);
      if (!recovered.ok) return recovered;

      const existing = await readExistingRecord(layout, record.identity);
      if (existing) {
        if (existing.requestDigest !== record.requestDigest) {
          return {
            ok: false,
            error: createResourceError('identity-conflict', {
              mutationIdentity: record.identity,
            }),
          };
        }
        return { ok: true, value: undefined };
      }

      const currentRevision = await readHead(layout);
      if (currentRevision !== record.result.beforeRevision) {
        return {
          ok: false,
          error: createResourceError('stale-revision', {
            expected: record.result.beforeRevision,
            actual: currentRevision,
          }),
        };
      }

      if (!record.result.changed) {
        try {
          await writeTerminal(layout, record);
          return { ok: true, value: undefined };
        } catch (error) {
          return failure('commitMutation', error);
        }
      }

      const persisted = await persistManifest(layout, snapshot, record);
      if (!persisted.ok) return persisted;
      const prepared: PreparedRecord = {
        identity: record.identity,
        requestDigest: record.requestDigest,
        beforeRevision: record.result.beforeRevision,
        afterRevision: record.result.afterRevision,
        manifestRevision: snapshot.revision,
        record,
      };
      await writePrepared(layout, prepared);
      await replaceHead(layout, snapshot.revision);
      try {
        await writeTerminal(layout, record);
      } catch (error) {
        return failure('commitMutation', error);
      }
      try {
        trigger('cleanup');
        await rm(join(layout.preparedDirectory, `${digest(prepared.identity)}.json`), { force: true });
      } catch {
        // Cleanup is advisory; HEAD and the terminal record are authoritative.
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('commitMutation', error);
    } finally {
      await releaseInternalLease(lease.value);
    }
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
    const persisted = parseManifest(await readFile(path, 'utf8'));
    const active: Record<string, Uint8Array> = {};
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
      const active: Record<string, string> = {};
      for (const [resourceId, bytes] of Object.entries(snapshot.active)) {
        const blobDigest = await persistBlob(layout, bytes);
        active[resourceId] = blobDigest;
      }
      const trash: PersistedTrashEntry[] = [];
      for (const entry of snapshot.trash) {
        trash.push({
          resourceId: entry.resourceId,
          digest: await persistBlob(layout, entry.bytes),
          mutationIdentity: entry.mutationIdentity,
          revision: entry.revision,
        });
      }
      const path = join(layout.revisionsDirectory, `${snapshot.revision}.json`);
      await assertControlFile(path);
      trigger('manifest-write');
      await atomicWrite(
        path,
        serializeManifest({
          revision: snapshot.revision,
          parentRevision: record?.result.beforeRevision ?? null,
          mutationIdentity: record?.identity,
          resourceIds: record?.resourceIds ?? [],
          active,
          trash,
        }),
      );
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
    }
    return blobDigest;
  }

  async function readBlob(layout: DurableLayout, blobDigest: string): Promise<Uint8Array> {
    if (!/^[a-f0-9]{64}$/.test(blobDigest)) throw new Error('invalid blob digest');
    const path = join(layout.blobsDirectory, blobDigest);
    await assertControlFile(path);
    return new Uint8Array(await readFile(path));
  }

  async function writePrepared(layout: DurableLayout, prepared: PreparedRecord): Promise<void> {
    const path = join(layout.preparedDirectory, `${digest(prepared.identity)}.json`);
    await assertControlFile(path);
    trigger('prepared-write');
    await atomicWrite(path, JSON.stringify(prepared));
    trigger('prepared-fsync');
    await fsyncFile(path);
  }

  async function writeTerminal(
    layout: DurableLayout,
    record: ResourceMutationRecord,
  ): Promise<void> {
    const path = join(layout.mutationsDirectory, `${digest(record.identity)}.json`);
    await assertControlFile(path);
    trigger('terminal-write');
    await atomicWrite(path, JSON.stringify(record));
    trigger('terminal-fsync');
    await fsyncFile(path);
  }

  async function replaceHead(layout: DurableLayout, revision: string): Promise<void> {
    const path = join(layout.stateDirectory, 'HEAD');
    await assertControlFile(path);
    trigger('head-replace');
    await atomicWrite(path, `${revision}\n`);
    trigger('after-head-replace');
    trigger('head-fsync');
    await fsyncFile(path);
  }

  async function recoverPrepared(layout: DurableLayout): Promise<ResourceResult<void>> {
    try {
      const entries = await readdir(layout.preparedDirectory);
      for (const entry of entries) {
        if (!entry.endsWith('.json')) continue;
        const path = join(layout.preparedDirectory, entry);
        await assertControlFile(path);
        const prepared = JSON.parse(await readFile(path, 'utf8')) as PreparedRecord;
        const currentRevision = await readHead(layout);
        const decision = classifyPreparedRecovery(
          prepared.beforeRevision,
          currentRevision,
          prepared.afterRevision,
        );
        if (!decision.ok) return decision;
        if (decision.value === 'keep-after') {
          if (!(await readExistingRecord(layout, prepared.record.identity))) {
            await writeTerminal(layout, prepared.record);
          }
        }
        await rm(path, { force: true });
      }
      return { ok: true, value: undefined };
    } catch (error) {
      return failure('readSnapshot', error);
    }
  }

  async function readExistingRecord(
    layout: DurableLayout,
    identity: ResourceMutationIdentity | string,
  ): Promise<ResourceMutationRecord | null> {
    const path = join(layout.mutationsDirectory, `${digest(identity)}.json`);
    if (!(await exists(path))) return null;
    await assertControlFile(path);
    return parseRecord(await readFile(path, 'utf8'));
  }

  async function readHead(layout: DurableLayout): Promise<string> {
    const path = join(layout.stateDirectory, 'HEAD');
    await assertControlFile(path);
    const revision = (await readFile(path, 'utf8')).trim();
    if (!revision) throw new Error('empty HEAD');
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

  async function releaseInternalLease(owner: WriterLeaseHandle): Promise<void> {
    await owner.release();
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

function serializeManifest(snapshot: ResourceSnapshot | PersistedManifest): string {
  if ('bytes' in snapshot) return JSON.stringify(snapshot);
  return JSON.stringify(snapshot);
}

function parseManifest(value: string): PersistedManifest {
  const parsed = JSON.parse(value) as PersistedManifest;
  if (!parsed || typeof parsed.revision !== 'string' || !parsed.active || !Array.isArray(parsed.trash)) {
    throw new Error('invalid revision manifest');
  }
  return parsed;
}

function parseRecord(value: string): ResourceMutationRecord {
  const parsed = JSON.parse(value) as ResourceMutationRecord;
  if (!parsed || typeof parsed.identity !== 'string' || typeof parsed.requestDigest !== 'string') {
    throw new Error('invalid mutation record');
  }
  return parsed;
}

async function atomicWrite(path: string, data: string | Uint8Array): Promise<void> {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(temporary, data, { flag: 'wx' });
  await rename(temporary, path);
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
