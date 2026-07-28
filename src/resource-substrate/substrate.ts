/**
 * ResourceRoot coordinator for the injected M2 store.
 *
 * Identity lookup happens before revision validation. The store's atomic
 * commit seam keeps the candidate snapshot and terminal identity record
 * together; filesystem durability is supplied by the later store milestone.
 */
import {
  createResourceError,
  RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
  type ResourceMutation,
  type ResourceId,
  type ResourceMutationIdentity,
  type ResourceMutationRecord,
  type ResourceMutationResult,
  type ResourceObserverCallback,
  type ResourceObserverOptions,
  type ResourceObserverSubscription,
  type ResourceObserverSource,
  type ResourceResult,
  type ResourceRoot,
  type ResourceRootDescriptor,
  type ResourceSnapshot,
} from './contract';
import { canonicalizeResourceMutation, reduceResourceMutation } from './manifest';
import { createResourceObserverCoordinator, type ResourceObserverCoordinator } from './observer';
import type { ResourceStore } from './storage';

export interface OpenResourceRootOptions {
  readonly rootId: string;
  readonly store: ResourceStore;
  readonly observerSource?: ResourceObserverSource;
}

export async function openResourceRoot(
  options: OpenResourceRootOptions,
): Promise<ResourceResult<ResourceRoot>> {
  if (!options.rootId) {
    return {
      ok: false,
      error: createResourceError('root-boundary-violation', {
        rootId: options.rootId,
        hint: 'Provide a non-empty logical root id.',
      }),
    };
  }

  const descriptor: ResourceRootDescriptor = {
    rootId: options.rootId,
    capabilityVersion: RESOURCE_SUBSTRATE_CAPABILITY_VERSION,
  };
  const observer = createResourceObserverCoordinator({
    rootId: options.rootId,
    store: options.store,
    source: options.observerSource,
  });
  const root: ResourceRoot = {
    descriptor,
    async readSnapshot() {
      return options.store.readSnapshot(options.rootId);
    },
    async commit(mutation) {
      return commitMutation(options.rootId, options.store, observer, mutation);
    },
    async listTrash() {
      const snapshot = await options.store.readSnapshot(options.rootId);
      if (!snapshot.ok) return snapshot;
      return { ok: true, value: snapshot.value.trash };
    },
    async observe(
      observerOptions: ResourceObserverOptions,
      callback: ResourceObserverCallback,
    ): Promise<ResourceResult<ResourceObserverSubscription>> {
      return observer.observe(observerOptions, callback);
    },
  };
  return { ok: true, value: root };
}

async function commitMutation(
  rootId: string,
  store: ResourceStore,
  observer: ResourceObserverCoordinator,
  mutation: ResourceMutation,
): Promise<ResourceResult<ResourceMutationResult>> {
  const identity = String(mutation.identity) as ResourceMutationIdentity;
  const prior = await store.readMutation(rootId, identity);
  if (!prior.ok) return prior;

  const canonical = canonicalizeResourceMutation(mutation);
  if (!canonical.ok) return canonical;
  if (prior.value) {
    if (prior.value.requestDigest !== canonical.value.requestDigest) {
      return {
        ok: false,
        error: createResourceError('identity-conflict', {
          mutationIdentity: identity,
        }),
      };
    }
    return { ok: true, value: { ...prior.value.result } };
  }

  const current = await store.readSnapshot(rootId);
  if (!current.ok) return current;

  const reduced = reduceResourceMutation(
    current.value,
    mutation,
    prior.value ? [prior.value] : [],
  );
  if (!reduced.ok) return reduced;

  const record: ResourceMutationRecord = {
    identity,
    requestDigest: reduced.value.requestDigest,
    result: reduced.value.result,
    resourceIds: resourceIdsForMutation(mutation),
  };
  const committed = await store.commitMutation(rootId, reduced.value.snapshot, record);
  if (!committed.ok) return committed;
  await observer.publishCommitted(record);
  return { ok: true, value: reduced.value.result };
}

function resourceIdsForMutation(mutation: ResourceMutation): readonly ResourceId[] {
  const ids = new Set<ResourceId>();
  for (const change of mutation.changes) {
    if (change.kind === 'move') {
      ids.add(String(change.from) as ResourceId);
      ids.add(String(change.to) as ResourceId);
    } else if (change.kind === 'restore') {
      ids.add(String(change.resourceId) as ResourceId);
      ids.add(String(change.targetResourceId ?? change.resourceId) as ResourceId);
    } else {
      ids.add(String(change.resourceId) as ResourceId);
    }
  }
  return [...ids];
}

export async function readResourceSnapshot(
  root: ResourceRoot,
): Promise<ResourceResult<ResourceSnapshot>> {
  return root.readSnapshot();
}
