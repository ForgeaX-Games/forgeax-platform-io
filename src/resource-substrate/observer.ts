/**
 * Resource observer coordinator.
 *
 * Internal commits are reconstructed from the durable revision parent chain.
 * External source signals are deliberately weaker facts and are mapped to
 * invalidation, gap, or error events instead of being treated as commits.
 */
import {
  createResourceError,
  type ResourceObserverCallback,
  type ResourceObserverEvent,
  type ResourceObserverSource,
  type ResourceObserverSourceEvent,
  type ResourceObserverSourceSubscription,
  type ResourceObserverSubscription,
  type ResourceResult,
  type ResourceRevision,
  type ResourceRevisionInfo,
  type ResourceMutationRecord,
} from './contract';
import type { ResourceStore } from './storage';

const MAX_QUEUE_SIZE = 256;

interface RevisionReadableStore extends ResourceStore {
  readonly readRevision?: (
    rootId: string,
    revision: ResourceRevision,
  ) => Promise<ResourceResult<ResourceRevisionInfo | null>>;
}

interface ObserverState {
  readonly baselineRevision: ResourceRevision;
  readonly callback: ResourceObserverCallback;
  readonly closed: Promise<void>;
  readonly resolveClosed: () => void;
  queue: ResourceObserverEvent[];
  delivery: Promise<void>;
  closing: boolean;
  sourceClosed: boolean;
  sourceSubscription?: ResourceObserverSourceSubscription;
  currentRevision: ResourceRevision;
}

export interface ResourceObserverCoordinator {
  observe(
    options: { readonly baselineRevision: ResourceRevision },
    callback: ResourceObserverCallback,
  ): Promise<ResourceResult<ResourceObserverSubscription>>;
  publishCommitted(record: ResourceMutationRecord): Promise<void>;
}

export interface ResourceObserverCoordinatorOptions {
  readonly rootId: string;
  readonly store: ResourceStore;
  readonly source?: ResourceObserverSource;
}

export function createResourceObserverCoordinator(
  options: ResourceObserverCoordinatorOptions,
): ResourceObserverCoordinator {
  const store = options.store as RevisionReadableStore;
  const observers = new Set<ObserverState>();

  async function observe(
    observerOptions: { readonly baselineRevision: ResourceRevision },
    callback: ResourceObserverCallback,
  ): Promise<ResourceResult<ResourceObserverSubscription>> {
    const current = await store.readSnapshot(options.rootId);
    if (!current.ok) return current;

    let resolveClosed!: () => void;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });
    const state: ObserverState = {
      baselineRevision: observerOptions.baselineRevision,
      callback,
      closed,
      resolveClosed,
      queue: [],
      delivery: Promise.resolve(),
      closing: false,
      sourceClosed: options.source === undefined,
      currentRevision: current.value.revision,
    };
    observers.add(state);

    await replayFromBaseline(state, current.value.revision);
    if (options.source) {
      try {
        const sourceCallback = (event: ResourceObserverSourceEvent) =>
          handleSourceEvent(state, event);
        state.sourceSubscription = await options.source.subscribe(sourceCallback);
      } catch (error) {
        state.sourceClosed = true;
        await enqueueError(state, error);
      }
    }
    maybeResolveClosed(state);

    const subscription: ResourceObserverSubscription = {
      closed,
      close: () => close(state),
    };
    return { ok: true, value: subscription };
  }

  async function publishCommitted(record: ResourceMutationRecord): Promise<void> {
    if (!record.result.changed) return;
    const event: ResourceObserverEvent = {
      kind: 'committed',
      rootId: options.rootId,
      mutationIdentity: record.identity,
      beforeRevision: record.result.beforeRevision,
      afterRevision: record.result.afterRevision,
      resourceIds: (record.resourceIds ?? []) as ResourceRevisionInfo['resourceIds'],
    };
    await Promise.all([...observers].map((state) => {
      state.currentRevision = record.result.afterRevision;
      return enqueue(state, event);
    }));
  }

  async function replayFromBaseline(
    state: ObserverState,
    currentRevision: ResourceRevision,
  ): Promise<void> {
    if (state.baselineRevision === currentRevision) return;
    const readRevision = store.readRevision;
    if (!readRevision) {
      await enqueue(state, gap(state.baselineRevision, currentRevision));
      return;
    }

    const chain: ResourceRevisionInfo[] = [];
    const visited = new Set<ResourceRevision>();
    let cursor = currentRevision;
    while (cursor !== state.baselineRevision) {
      if (visited.has(cursor)) {
        await enqueue(state, gap(state.baselineRevision, currentRevision));
        return;
      }
      visited.add(cursor);
      const revision = await readRevision(options.rootId, cursor);
      if (!revision.ok) {
        await enqueueError(state, revision.error.message);
        return;
      }
      if (!revision.value?.parentRevision || !revision.value.mutationIdentity) {
        await enqueue(state, gap(state.baselineRevision, currentRevision));
        return;
      }
      chain.push(revision.value);
      cursor = revision.value.parentRevision;
    }

    for (const revision of chain.reverse()) {
      await enqueue(state, {
        kind: 'committed',
        rootId: options.rootId,
        mutationIdentity: revision.mutationIdentity as NonNullable<ResourceRevisionInfo['mutationIdentity']>,
        beforeRevision: revision.parentRevision as ResourceRevision,
        afterRevision: revision.revision,
        resourceIds: revision.resourceIds,
      });
    }
  }

  async function handleSourceEvent(
    state: ObserverState,
    event: ResourceObserverSourceEvent,
  ): Promise<void> {
    if (state.closing) return;
    const current = await store.readSnapshot(options.rootId);
    if (!current.ok) {
      await enqueueError(state, current.error.message);
      return;
    }
    state.currentRevision = current.value.revision;
    if (event.kind === 'change') {
      const invalidation = createResourceError('observer-invalidation');
      await enqueue(state, {
        kind: 'invalidation',
        code: 'observer-invalidation',
        rootId: options.rootId,
        currentRevision: current.value.revision,
        hint: invalidation.hint,
      });
      return;
    }
    if (event.kind === 'overflow') {
      await enqueue(state, gap(state.baselineRevision, current.value.revision));
      return;
    }
    await enqueueError(state, event.reason ?? 'Observer source failed.');
  }

  async function close(state: ObserverState): Promise<void> {
    if (!state.closing) {
      state.closing = true;
      if (state.sourceSubscription) {
        try {
          await state.sourceSubscription.close();
        } catch {
          // Closing is terminal; a source close failure must not reopen delivery.
        }
      }
      state.sourceClosed = true;
      observers.delete(state);
      maybeResolveClosed(state);
    }
    await state.closed;
  }

  function enqueue(state: ObserverState, event: ResourceObserverEvent): Promise<void> {
    if (state.closing && state.queue.length === 0) return state.closed;
    if (state.queue.length >= MAX_QUEUE_SIZE) {
      state.queue = [gap(state.baselineRevision, state.currentRevision)];
    }
    state.queue.push(event);
    state.delivery = state.delivery.then(() => drain(state));
    return state.delivery;
  }

  async function drain(state: ObserverState): Promise<void> {
    while (state.queue.length > 0) {
      const event = state.queue.shift();
      if (!event) continue;
      try {
        await state.callback(event);
      } catch (error) {
        if (event.kind !== 'error' && !state.closing) {
          state.queue.unshift(observerError(state.currentRevision, errorMessage(error)));
        }
      }
    }
    maybeResolveClosed(state);
  }

  function maybeResolveClosed(state: ObserverState): void {
    if (state.closing && state.sourceClosed && state.queue.length === 0) {
      state.resolveClosed();
    }
  }

  function gap(
    baselineRevision: ResourceRevision,
    currentRevision: ResourceRevision,
  ): ResourceObserverEvent {
    return {
      kind: 'gap',
      code: 'observer-gap',
      rootId: options.rootId,
      baselineRevision,
      currentRevision,
      hint: createResourceError('observer-gap', {
        expected: baselineRevision,
        actual: currentRevision,
      }).hint,
    };
  }

  function observerError(currentRevision: ResourceRevision, reason: string): ResourceObserverEvent {
    return {
      kind: 'error',
      rootId: options.rootId,
      currentRevision,
      error: createResourceError('observer-error', {
        storageReason: reason,
      }),
    };
  }

  async function enqueueError(state: ObserverState, error: unknown): Promise<void> {
    await enqueue(state, observerError(state.currentRevision, errorMessage(error)));
  }

  return { observe, publishCommitted };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
