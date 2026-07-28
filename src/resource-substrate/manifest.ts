/**
 * Pure resource manifest state machine.
 *
 * The reducer validates the complete participation set before cloning or
 * applying any change. It does not know about files, roots on disk, or
 * durability; those concerns belong to ResourceStore adapters.
 */
import {
  createResourceError,
  type ResourceId,
  type ResourceMutation,
  type ResourceMutationChange,
  type ResourceMutationRecord,
  type ResourceMutationResult,
  type ResourceResult,
  type ResourceRevision,
  type ResourceSnapshot,
  type ResourceTrashEntry,
} from './contract';
import { normalizeResourceId } from './resource-id';

export type ResourceManifest = ResourceSnapshot;

export interface ManifestReduction {
  readonly snapshot: ResourceSnapshot;
  readonly result: ResourceMutationResult;
  readonly requestDigest: string;
}

interface NormalizedPutChange {
  readonly kind: 'put';
  readonly resourceId: ResourceId;
  readonly bytes: Uint8Array;
}

interface NormalizedMoveChange {
  readonly kind: 'move';
  readonly from: ResourceId;
  readonly to: ResourceId;
}

interface NormalizedTrashChange {
  readonly kind: 'trash';
  readonly resourceId: ResourceId;
}

interface NormalizedRestoreChange {
  readonly kind: 'restore';
  readonly resourceId: ResourceId;
  readonly targetResourceId: ResourceId;
}

type NormalizedChange =
  | NormalizedPutChange
  | NormalizedMoveChange
  | NormalizedTrashChange
  | NormalizedRestoreChange;

interface NormalizedMutation {
  readonly identity: string;
  readonly expectedRevision: ResourceRevision;
  readonly changes: readonly NormalizedChange[];
}

export function createInitialManifest(revision: ResourceRevision): ResourceManifest {
  return {
    revision,
    active: {},
    trash: [],
  };
}

export function readManifestSnapshot(snapshot: ResourceSnapshot): ResourceSnapshot {
  return cloneSnapshot(snapshot);
}

export function canonicalizeResourceMutation(
  mutation: ResourceMutation,
): ResourceResult<{ readonly mutation: NormalizedMutation; readonly requestDigest: string }> {
  const normalizedChanges: NormalizedChange[] = [];
  const participation = new Set<string>();

  for (const change of mutation.changes) {
    const normalized = normalizeChange(change);
    if (!normalized.ok) return normalized;
    const ids = changeResourceIds(normalized.value);
    if (ids.some((id) => participation.has(id))) {
      return {
        ok: false,
        error: createResourceError('resource-conflict', {
          hint: 'Use each logical resource id at most once per mutation.',
        }),
      };
    }
    for (const id of ids) participation.add(id);
    normalizedChanges.push(normalized.value);
  }

  const normalizedMutation: NormalizedMutation = {
    identity: String(mutation.identity),
    expectedRevision: String(mutation.expectedRevision) as ResourceRevision,
    changes: normalizedChanges,
  };
  return {
    ok: true,
    value: {
      mutation: normalizedMutation,
      requestDigest: digestMutation(normalizedMutation),
    },
  };
}

export function reduceResourceMutation(
  current: ResourceSnapshot,
  mutation: ResourceMutation,
  knownMutations: readonly ResourceMutationRecord[] = [],
): ResourceResult<ManifestReduction> {
  const canonical = canonicalizeResourceMutation(mutation);
  if (!canonical.ok) return canonical;

  const { mutation: normalized, requestDigest } = canonical.value;
  const prior = knownMutations.find((record) => record.identity === normalized.identity);
  if (prior) {
    if (prior.requestDigest !== requestDigest) {
      return {
        ok: false,
        error: createResourceError('identity-conflict', {
          mutationIdentity: normalized.identity,
        }),
      };
    }
    return {
      ok: true,
      value: {
        snapshot: cloneSnapshot(current),
        result: cloneMutationResult(prior.result),
        requestDigest,
      },
    };
  }

  if (normalized.expectedRevision !== current.revision) {
    return {
      ok: false,
      error: createResourceError('stale-revision', {
        expected: normalized.expectedRevision,
        actual: current.revision,
      }),
    };
  }

  const active = cloneActive(current.active);
  const trash = current.trash.map(cloneTrashEntry);
  const beforeRevision = current.revision;
  let changed = false;

  for (const change of normalized.changes) {
    const outcome = applyChange(change, active, trash, normalized.identity);
    if (!outcome.ok) return outcome;
    changed ||= outcome.value;
  }

  const afterRevision = changed
    ? createRevision(beforeRevision, requestDigest, active, trash)
    : beforeRevision;
  const finalizedTrash = trash.map((entry) => ({
    ...entry,
    revision:
      entry.revision === ('pending' as ResourceRevision) && changed
        ? afterRevision
        : entry.revision,
  }));
  const snapshot: ResourceSnapshot = {
    revision: afterRevision,
    active,
    trash: finalizedTrash,
  };
  return {
    ok: true,
    value: {
      snapshot,
      result: {
        identity: normalized.identity as ResourceMutationResult['identity'],
        beforeRevision,
        afterRevision,
        changed,
      },
      requestDigest,
    },
  };
}

function normalizeChange(
  change: ResourceMutationChange,
): ResourceResult<NormalizedChange> {
  if (change.kind === 'put') {
    const resourceId = normalizeResourceId(change.resourceId);
    if (!resourceId.ok) return resourceId;
    if (!(change.bytes instanceof Uint8Array)) {
      return {
        ok: false,
        error: createResourceError('resource-conflict', {
          hint: 'Provide opaque resource content as Uint8Array bytes.',
        }),
      };
    }
    return { ok: true, value: { kind: 'put', resourceId: resourceId.value, bytes: new Uint8Array(change.bytes) } };
  }

  if (change.kind === 'move') {
    const from = normalizeResourceId(change.from);
    if (!from.ok) return from;
    const to = normalizeResourceId(change.to);
    if (!to.ok) return to;
    return { ok: true, value: { kind: 'move', from: from.value, to: to.value } };
  }

  const resourceId = normalizeResourceId(change.resourceId);
  if (!resourceId.ok) return resourceId;
  if (change.kind === 'trash') {
    return { ok: true, value: { kind: 'trash', resourceId: resourceId.value } };
  }
  const target = normalizeResourceId(change.targetResourceId ?? change.resourceId);
  if (!target.ok) return target;
  return {
    ok: true,
    value: { kind: 'restore', resourceId: resourceId.value, targetResourceId: target.value },
  };
}

function changeResourceIds(change: NormalizedChange): readonly string[] {
  if (change.kind === 'move') return [change.from, change.to];
  if (change.kind === 'restore') {
    return change.resourceId === change.targetResourceId
      ? [change.resourceId]
      : [change.resourceId, change.targetResourceId];
  }
  return [change.resourceId];
}

function applyChange(
  change: NormalizedChange,
  active: Record<string, Uint8Array>,
  trash: ResourceTrashEntry[],
  mutationIdentity: string,
): ResourceResult<boolean> {
  if (change.kind === 'put') {
    const existing = active[change.resourceId];
    if (existing && equalBytes(existing, change.bytes)) return { ok: true, value: false };
    active[change.resourceId] = new Uint8Array(change.bytes);
    return { ok: true, value: true };
  }

  if (change.kind === 'move') {
    const source = active[change.from];
    if (!source) return missingResource(change.from);
    if (active[change.to] || trash.some((entry) => entry.resourceId === change.to)) {
      return resourceConflict(change.to);
    }
    active[change.to] = new Uint8Array(source);
    delete active[change.from];
    return { ok: true, value: true };
  }

  if (change.kind === 'trash') {
    const source = active[change.resourceId];
    if (!source) return missingResource(change.resourceId);
    delete active[change.resourceId];
    trash.push({
      resourceId: change.resourceId,
      bytes: new Uint8Array(source),
      mutationIdentity: mutationIdentity as ResourceTrashEntry['mutationIdentity'],
      revision: 'pending' as ResourceRevision,
    });
    return { ok: true, value: true };
  }

  const entryIndex = trash.findIndex((entry) => entry.resourceId === change.resourceId);
  if (entryIndex < 0) return missingResource(change.resourceId);
  if (active[change.targetResourceId]) return resourceConflict(change.targetResourceId);
  const entry = trash[entryIndex];
  if (!entry) return missingResource(change.resourceId);
  active[change.targetResourceId] = new Uint8Array(entry.bytes);
  trash.splice(entryIndex, 1);
  return { ok: true, value: true };
}

function missingResource(resourceId: ResourceId): ResourceResult<never> {
  return {
    ok: false,
    error: createResourceError('resource-not-found', { resourceId }),
  };
}

function resourceConflict(resourceId: ResourceId): ResourceResult<never> {
  return {
    ok: false,
    error: createResourceError('resource-conflict', { resourceId }),
  };
}

function cloneSnapshot(snapshot: ResourceSnapshot): ResourceSnapshot {
  return {
    revision: snapshot.revision,
    active: cloneActive(snapshot.active),
    trash: snapshot.trash.map(cloneTrashEntry),
  };
}

function cloneActive(active: Readonly<Record<string, Uint8Array>>): Record<string, Uint8Array> {
  return Object.fromEntries(Object.entries(active).map(([id, bytes]) => [id, new Uint8Array(bytes)]));
}

function cloneTrashEntry(entry: ResourceTrashEntry): ResourceTrashEntry {
  return { ...entry, bytes: new Uint8Array(entry.bytes) };
}

function cloneMutationResult(result: ResourceMutationResult): ResourceMutationResult {
  return { ...result };
}

function digestMutation(mutation: NormalizedMutation): string {
  const serialized = JSON.stringify({
    expectedRevision: mutation.expectedRevision,
    changes: mutation.changes.map((change) => {
      if (change.kind === 'put') {
        return { kind: change.kind, resourceId: change.resourceId, bytes: Array.from(change.bytes) };
      }
      return change;
    }),
  });
  return `mutation-${hash(serialized)}`;
}

function createRevision(
  before: ResourceRevision,
  requestDigest: string,
  active: Readonly<Record<string, Uint8Array>>,
  trash: readonly ResourceTrashEntry[],
): ResourceRevision {
  const state = JSON.stringify({
    before,
    requestDigest,
    active: Object.entries(active).map(([id, bytes]) => [id, Array.from(bytes)]),
    trash: trash.map((entry) => [entry.resourceId, Array.from(entry.bytes), entry.mutationIdentity]),
  });
  return `revision-${hash(state)}` as ResourceRevision;
}

function hash(value: string): string {
  let hashValue = 2166136261;
  for (let index = 0; index < value.length; index += 1) {
    hashValue ^= value.charCodeAt(index);
    hashValue = Math.imul(hashValue, 16777619);
  }
  return (hashValue >>> 0).toString(16).padStart(8, '0');
}

function equalBytes(left: Uint8Array, right: Uint8Array): boolean {
  if (left.byteLength !== right.byteLength) return false;
  return left.every((value, index) => value === right[index]);
}
