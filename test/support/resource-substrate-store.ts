import {
  createResourceError,
  type ResourceMutationIdentity,
  type ResourceMutationRecord,
  type ResourceResult,
  type ResourceRevision,
  type ResourceSnapshot,
} from '../../src/resource-substrate/contract';
import {
  type ResourceStore,
  type ResourceStoreOperation,
} from '../../src/resource-substrate/storage';
import { createInitialManifest, readManifestSnapshot } from '../../src/resource-substrate/manifest';

export interface MemoryResourceStore extends ResourceStore {
  failNext(operation: ResourceStoreOperation, reason?: string): void;
  failAlways(operation: ResourceStoreOperation, reason?: string): void;
  clearFaults(): void;
}

interface RootState {
  snapshot: ResourceSnapshot;
  mutations: Map<string, ResourceMutationRecord>;
}

interface Fault {
  readonly remaining: number | null;
  readonly reason: string;
}

export function createMemoryResourceStore(
  initialRevision: ResourceRevision = 'revision-0' as ResourceRevision,
): MemoryResourceStore {
  const roots = new Map<string, RootState>();
  const faults = new Map<ResourceStoreOperation, Fault>();

  function stateFor(rootId: string): RootState {
    const existing = roots.get(rootId);
    if (existing) return existing;
    const created: RootState = {
      snapshot: createInitialManifest(initialRevision),
      mutations: new Map(),
    };
    roots.set(rootId, created);
    return created;
  }

  function failure<T>(operation: ResourceStoreOperation): ResourceResult<T> | null {
    const fault = faults.get(operation);
    if (!fault) return null;
    if (fault.remaining !== null) {
      if (fault.remaining <= 1) faults.delete(operation);
      else faults.set(operation, { ...fault, remaining: fault.remaining - 1 });
    }
    return {
      ok: false,
      error: createResourceError('storage-failure', {
        storageReason: `${operation}: ${fault.reason}`,
        retryable: true,
      }),
    };
  }

  const store: MemoryResourceStore = {
    async readSnapshot(rootId) {
      const failed = failure<ResourceSnapshot>('readSnapshot');
      if (failed) return failed;
      return { ok: true, value: readManifestSnapshot(stateFor(rootId).snapshot) };
    },

    async writeSnapshot(rootId, snapshot) {
      const failed = failure<void>('writeSnapshot');
      if (failed) return failed;
      stateFor(rootId).snapshot = readManifestSnapshot(snapshot);
      return { ok: true, value: undefined };
    },

    async readMutation(rootId, identity: ResourceMutationIdentity) {
      const failed = failure<ResourceMutationRecord | null>('readMutation');
      if (failed) return failed;
      const record = stateFor(rootId).mutations.get(identity);
      return { ok: true, value: record ? cloneRecord(record) : null };
    },

    async writeMutation(rootId, record) {
      const failed = failure<void>('writeMutation');
      if (failed) return failed;
      stateFor(rootId).mutations.set(record.identity, cloneRecord(record));
      return { ok: true, value: undefined };
    },

    async commitMutation(rootId, snapshot, record) {
      const failed = failure<void>('commitMutation');
      if (failed) return failed;
      const state = stateFor(rootId);
      state.snapshot = readManifestSnapshot(snapshot);
      state.mutations.set(record.identity, cloneRecord(record));
      return { ok: true, value: undefined };
    },

    failNext(operation, reason = 'injected failure') {
      faults.set(operation, { remaining: 1, reason });
    },

    failAlways(operation, reason = 'injected failure') {
      faults.set(operation, { remaining: null, reason });
    },

    clearFaults() {
      faults.clear();
    },
  };

  return store;
}

function cloneRecord(record: ResourceMutationRecord): ResourceMutationRecord {
  return {
    ...record,
    result: { ...record.result },
  };
}
