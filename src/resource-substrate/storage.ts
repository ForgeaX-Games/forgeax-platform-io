/**
 * Storage port for ResourceRoot.
 *
 * Adapters own durable layout and failure injection. The port carries complete
 * revision-bound snapshots and mutation terminal records, never business data.
 */
import type {
  ResourceMutationIdentity,
  ResourceMutationRecord,
  ResourceResult,
  ResourceSnapshot,
} from './contract';

export type ResourceStoreOperation =
  | 'readSnapshot'
  | 'writeSnapshot'
  | 'readMutation'
  | 'writeMutation'
  | 'commitMutation';

export type FilesystemStoreFailpoint =
  | 'blob-write'
  | 'blob-fsync'
  | 'manifest-write'
  | 'manifest-fsync'
  | 'prepared-write'
  | 'prepared-fsync'
  | 'head-replace'
  | 'after-head-replace'
  | 'head-fsync'
  | 'terminal-write'
  | 'terminal-fsync'
  | 'cleanup';

export interface ResourceStoreFailureFacts {
  readonly operation: ResourceStoreOperation;
  readonly reason: string;
}

export interface ResourceStore {
  readSnapshot(rootId: string): Promise<ResourceResult<ResourceSnapshot>>;
  writeSnapshot(rootId: string, snapshot: ResourceSnapshot): Promise<ResourceResult<void>>;
  readMutation(
    rootId: string,
    identity: ResourceMutationIdentity,
  ): Promise<ResourceResult<ResourceMutationRecord | null>>;
  writeMutation(rootId: string, record: ResourceMutationRecord): Promise<ResourceResult<void>>;
  commitMutation(
    rootId: string,
    snapshot: ResourceSnapshot,
    record: ResourceMutationRecord,
  ): Promise<ResourceResult<void>>;
}

export interface FilesystemResourceStore extends ResourceStore {
  readonly stateDirectory: string;
  readSnapshotAt(rootId: string, revision: string): Promise<ResourceResult<ResourceSnapshot>>;
  failNext(failpoint: FilesystemStoreFailpoint, reason?: string): void;
  failAlways(failpoint: FilesystemStoreFailpoint, reason?: string): void;
  clearFaults(): void;
}
