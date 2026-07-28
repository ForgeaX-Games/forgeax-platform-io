/**
 * Business-agnostic resource substrate vocabulary.
 *
 * The contract describes logical resources as opaque bytes and keeps root,
 * revision, mutation, trash, observer, and error facts serializable. Durable
 * mutation behavior is implemented by later layers behind ResourceStore.
 */

export const RESOURCE_SUBSTRATE_CAPABILITY_VERSION = 'resource-substrate.v1' as const;

export const RESOURCE_SUBSTRATE_PUBLIC_TYPES = [
  'ResourceRoot',
  'ResourceMutation',
  'ResourceRevision',
  'ResourceTrashEntry',
  'ResourceObserverEvent',
  'ResourceStore',
  'ResourceResult',
  'ResourceError',
] as const;

export type ResourceCapabilityName =
  | 'root'
  | 'mutation'
  | 'revision'
  | 'trash'
  | 'observer';

export interface ResourceCapabilityDescriptor {
  readonly name: ResourceCapabilityName;
  readonly version: typeof RESOURCE_SUBSTRATE_CAPABILITY_VERSION;
  readonly status: 'contract' | 'available';
  readonly summary: string;
}

export interface ResourceCapabilityIndex {
  readonly version: typeof RESOURCE_SUBSTRATE_CAPABILITY_VERSION;
  readonly capabilities: readonly ResourceCapabilityName[];
  readonly descriptors: readonly ResourceCapabilityDescriptor[];
  readonly publicTypes: typeof RESOURCE_SUBSTRATE_PUBLIC_TYPES;
}

const capabilityDescriptors = [
  {
    name: 'root',
    version: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
    status: 'contract',
    summary: 'Scopes resources behind one logical root.',
  },
  {
    name: 'mutation',
    version: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
    status: 'contract',
    summary: 'Describes one identity-bound resource change set.',
  },
  {
    name: 'revision',
    version: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
    status: 'contract',
    summary: 'Provides opaque equality tokens for committed root state.',
  },
  {
    name: 'trash',
    version: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
    status: 'contract',
    summary: 'Describes recoverable logical deletion state.',
  },
  {
    name: 'observer',
    version: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
    status: 'available',
    summary: 'Reports committed facts and explicit resynchronization signals.',
  },
] as const satisfies readonly ResourceCapabilityDescriptor[];

export const RESOURCE_SUBSTRATE_CAPABILITY_INDEX = {
  version: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
  capabilities: capabilityDescriptors.map((descriptor) => descriptor.name),
  descriptors: capabilityDescriptors,
  publicTypes: RESOURCE_SUBSTRATE_PUBLIC_TYPES,
} as const satisfies ResourceCapabilityIndex;

export const RESOURCE_SUBSTRATE_CAPABILITIES = RESOURCE_SUBSTRATE_CAPABILITY_INDEX;

export type ResourceId = string & { readonly __resourceId: unique symbol };
export type ResourceRevision = string & { readonly __resourceRevision: unique symbol };
export type ResourceMutationIdentity = string & {
  readonly __resourceMutationIdentity: unique symbol;
};

export interface ResourceRootDescriptor {
  readonly rootId: string;
  readonly capabilityVersion: typeof RESOURCE_SUBSTRATE_CAPABILITY_VERSION;
}

export interface ResourcePutChange {
  readonly kind: 'put';
  readonly resourceId: ResourceId | string;
  readonly bytes: Uint8Array;
}

export interface ResourceMoveChange {
  readonly kind: 'move';
  readonly from: ResourceId | string;
  readonly to: ResourceId | string;
}

export interface ResourceTrashChange {
  readonly kind: 'trash';
  readonly resourceId: ResourceId | string;
}

export interface ResourceRestoreChange {
  readonly kind: 'restore';
  readonly resourceId: ResourceId | string;
  readonly targetResourceId?: ResourceId | string;
}

export type ResourceMutationChange =
  | ResourcePutChange
  | ResourceMoveChange
  | ResourceTrashChange
  | ResourceRestoreChange;

export interface ResourceMutation {
  readonly identity: ResourceMutationIdentity | string;
  readonly expectedRevision: ResourceRevision | string;
  readonly changes: readonly ResourceMutationChange[];
}

export interface ResourceTrashEntry {
  readonly resourceId: ResourceId;
  readonly bytes: Uint8Array;
  readonly mutationIdentity: ResourceMutationIdentity;
  readonly revision: ResourceRevision;
}

export interface ResourceSnapshot {
  readonly revision: ResourceRevision;
  readonly active: Readonly<Record<string, Uint8Array>>;
  readonly trash: readonly ResourceTrashEntry[];
}

export interface ResourceMutationResult {
  readonly identity: ResourceMutationIdentity;
  readonly beforeRevision: ResourceRevision;
  readonly afterRevision: ResourceRevision;
  readonly changed: boolean;
}

export interface ResourceMutationRecord {
  readonly identity: ResourceMutationIdentity;
  readonly requestDigest: string;
  readonly result: ResourceMutationResult;
  readonly resourceIds?: readonly ResourceId[];
}

export interface ResourceRevisionInfo {
  readonly revision: ResourceRevision;
  readonly parentRevision: ResourceRevision | null;
  readonly mutationIdentity?: ResourceMutationIdentity;
  readonly resourceIds: readonly ResourceId[];
}

export interface ResourceObserverCommittedEvent {
  readonly kind: 'committed';
  readonly rootId: string;
  readonly mutationIdentity: ResourceMutationIdentity;
  readonly beforeRevision: ResourceRevision;
  readonly afterRevision: ResourceRevision;
  readonly resourceIds: readonly ResourceId[];
}

export interface ResourceObserverInvalidationEvent {
  readonly kind: 'invalidation';
  readonly code: 'observer-invalidation';
  readonly rootId: string;
  readonly currentRevision: ResourceRevision;
  readonly hint: string;
}

export interface ResourceObserverGapEvent {
  readonly kind: 'gap';
  readonly code: 'observer-gap';
  readonly rootId: string;
  readonly baselineRevision: ResourceRevision;
  readonly currentRevision: ResourceRevision;
  readonly hint: string;
}

export interface ResourceObserverErrorEvent {
  readonly kind: 'error';
  readonly rootId: string;
  readonly currentRevision: ResourceRevision;
  readonly error: ResourceError;
}

export type ResourceObserverEvent =
  | ResourceObserverCommittedEvent
  | ResourceObserverInvalidationEvent
  | ResourceObserverGapEvent
  | ResourceObserverErrorEvent;

export interface ResourceObserverOptions {
  readonly baselineRevision: ResourceRevision;
}

export type ResourceObserverCallback = (event: ResourceObserverEvent) => unknown | Promise<unknown>;

export interface ResourceObserverSourceChangeEvent {
  readonly kind: 'change';
  readonly currentRevision?: ResourceRevision;
}

export interface ResourceObserverSourceOverflowEvent {
  readonly kind: 'overflow';
  readonly currentRevision?: ResourceRevision;
}

export interface ResourceObserverSourceErrorEvent {
  readonly kind: 'error';
  readonly currentRevision?: ResourceRevision;
  readonly reason?: string;
}

export type ResourceObserverSourceEvent =
  | ResourceObserverSourceChangeEvent
  | ResourceObserverSourceOverflowEvent
  | ResourceObserverSourceErrorEvent;

export type ResourceObserverSourceCallback = (
  event: ResourceObserverSourceEvent,
) => void | Promise<void>;

export interface ResourceObserverSourceSubscription {
  close(): void | Promise<void>;
}

export interface ResourceObserverSource {
  subscribe(
    callback: ResourceObserverSourceCallback,
  ): ResourceObserverSourceSubscription | Promise<ResourceObserverSourceSubscription>;
}

export interface ResourceObserverSubscription {
  readonly closed: Promise<void>;
  close(): Promise<void>;
}

export interface ResourceRoot {
  readonly descriptor: ResourceRootDescriptor;
  readSnapshot(): Promise<ResourceResult<ResourceSnapshot>>;
  commit(mutation: ResourceMutation): Promise<ResourceResult<ResourceMutationResult>>;
  listTrash(): Promise<ResourceResult<readonly ResourceTrashEntry[]>>;
  observe(
    options: ResourceObserverOptions,
    callback: ResourceObserverCallback,
  ): Promise<ResourceResult<ResourceObserverSubscription>>;
}

export type ResourceErrorCode =
  | 'invalid-resource-id'
  | 'root-boundary-violation'
  | 'root-confinement-violation'
  | 'recovery-required'
  | 'resource-not-found'
  | 'resource-conflict'
  | 'stale-revision'
  | 'identity-conflict'
  | 'storage-failure'
  | 'observer-gap'
  | 'observer-invalidation'
  | 'observer-error'
  | 'unsupported-capability';

export interface ResourceErrorFacts {
  readonly message?: string;
  readonly hint?: string;
  readonly retryable?: boolean;
  readonly expected?: string;
  readonly actual?: string;
  readonly rootId?: string;
  readonly resourceId?: string;
  readonly mutationIdentity?: string;
  readonly storageReason?: string;
}

interface ResourceErrorBase<C extends ResourceErrorCode> extends ResourceErrorFacts {
  readonly code: C;
  readonly message: string;
  readonly hint: string;
  readonly retryable: boolean;
}

export type ResourceError =
  | (ResourceErrorBase<'invalid-resource-id'> & { readonly resourceId?: string })
  | (ResourceErrorBase<'root-boundary-violation'> & { readonly resourceId?: string })
  | (ResourceErrorBase<'root-confinement-violation'> & { readonly storageReason?: string })
  | (ResourceErrorBase<'recovery-required'> & { readonly storageReason?: string })
  | (ResourceErrorBase<'resource-not-found'> & { readonly resourceId?: string })
  | (ResourceErrorBase<'resource-conflict'> & { readonly resourceId?: string })
  | (ResourceErrorBase<'stale-revision'> & {
      readonly expected?: string;
      readonly actual?: string;
    })
  | (ResourceErrorBase<'identity-conflict'> & { readonly mutationIdentity?: string })
  | (ResourceErrorBase<'storage-failure'> & { readonly storageReason?: string })
  | (ResourceErrorBase<'observer-gap'> & { readonly expected?: string; readonly actual?: string })
  | ResourceErrorBase<'observer-invalidation'>
  | (ResourceErrorBase<'observer-error'> & { readonly storageReason?: string })
  | ResourceErrorBase<'unsupported-capability'>;

export type ResourceResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: ResourceError };

const defaultHints: Record<ResourceErrorCode, string> = {
  'invalid-resource-id': 'Use a relative POSIX-like logical id without empty or dot segments.',
  'root-boundary-violation': 'Use a logical id relative to the selected resource root.',
  'root-confinement-violation': 'Repair the resource root control entries and retry without following symlinks.',
  'recovery-required': 'Resolve the prepared state before starting another mutation.',
  'resource-not-found': 'Refresh the root snapshot and choose an existing resource id.',
  'resource-conflict': 'Refresh the root snapshot and choose an unoccupied target.',
  'stale-revision': 'Read the current root snapshot and retry with a new mutation identity.',
  'identity-conflict': 'Reuse the original request or choose a new mutation identity.',
  'storage-failure': 'Retry after checking the storage failure facts; do not alter internal state.',
  'observer-gap': 'Read the current root snapshot before continuing observation.',
  'observer-invalidation': 'Read the current root snapshot to resynchronize after the external change.',
  'observer-error': 'Inspect the observer error facts and recreate the subscription if safe.',
  'unsupported-capability': 'Check the capability index before using this operation.',
};

const defaultRetryable: Record<ResourceErrorCode, boolean> = {
  'invalid-resource-id': false,
  'root-boundary-violation': false,
  'root-confinement-violation': false,
  'recovery-required': false,
  'resource-not-found': false,
  'resource-conflict': false,
  'stale-revision': true,
  'identity-conflict': false,
  'storage-failure': true,
  'observer-gap': true,
  'observer-invalidation': true,
  'observer-error': true,
  'unsupported-capability': false,
};

export function createResourceError(
  code: ResourceErrorCode,
  facts: ResourceErrorFacts = {},
): ResourceError {
  const { hint = defaultHints[code], retryable = defaultRetryable[code] } = facts;
  return {
    ...facts,
    code,
    message: facts.message ?? `Resource substrate operation failed: ${code}.`,
    hint,
    retryable,
  } as ResourceError;
}
