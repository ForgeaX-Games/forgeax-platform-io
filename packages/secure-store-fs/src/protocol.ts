/**
 * TypeScript view of the closed SSF1 protocol contract.
 *
 * The native header is the wire-level authority.  These values are mirrored
 * here so consumers cannot manufacture arbitrary parent/path operations.
 */
export const SECURE_STORE_FS_PROTOCOL_VERSION = 'SSF1' as const;
export const SECURE_STORE_FS_ARTIFACT_PROTOCOL_VERSION = 1 as const;

export const SECURE_STORE_FS_PROFILES = [
  'wire-capture-v1',
  'model-exchange-v1',
] as const;
export type SecureStoreFsProfile = (typeof SECURE_STORE_FS_PROFILES)[number];

export const SECURE_STORE_FS_PARENTS = ['root', 'blobs', 'reservations'] as const;
export type SecureStoreFsParent = (typeof SECURE_STORE_FS_PARENTS)[number];

export const SECURE_STORE_FS_OPERATIONS = [
  'ENSURE',
  'STORAGE',
  'READ',
  'WRITE_EXCLUSIVE',
  'APPEND',
  'WRITE_ATOMIC',
  'CREATE_IF_ABSENT',
  'REMOVE',
  'LIST',
  'MKDIR',
  'RMDIR',
  'RENAME_DIR',
  'SYNC',
  'LOCK_INSPECT',
  'LOCK_ACQUIRE',
  'LOCK_RECLAIM',
  'LOCK_HEARTBEAT',
  'LOCK_RELEASE',
  'CLOSE',
] as const;
export type SecureStoreFsOperation = (typeof SECURE_STORE_FS_OPERATIONS)[number];

export const SECURE_STORE_FS_TEST_BARRIERS = [
  'root-before-operation',
  'open-read',
  'open-append',
  'open-create',
  'atomic-replace',
  'atomic-replace-published',
  'atomic-create',
  'atomic-create-published',
  'unlink',
  'mkdir',
  'rmdir',
  'rename-dir',
  'lock-acquire',
  'lock-acquire-published',
  'lock-reclaim',
  'lock-heartbeat',
  'lock-release',
  'lock-remove-before-unpublish',
  'lock-release-unpublished',
  'writer-sequence-contended',
] as const;
export type SecureStoreFsTestBarrier = (typeof SECURE_STORE_FS_TEST_BARRIERS)[number];

export const SECURE_STORE_FS_LIMITS = {
  maxRootBytes: 4096,
  maxNameBytes: 255,
  maxOwnerBytes: 4096,
  maxContentBytes: 16 * 1024 * 1024,
  maxFileBytes: 16 * 1024 * 1024,
  maxFrameBytes: 64 * 1024 * 1024,
  maxListEntries: 4096,
} as const;

export type SecureStoreFsErrorCode =
  | 'secure_store_unsafe'
  | 'secure_store_io'
  | 'secure_store_protocol'
  | 'secure_store_unsupported'
  | 'secure_store_not_found'
  | 'secure_store_exists'
  | 'secure_store_value_limit'
  | 'secure_store_root_missing'
  | 'secure_store_helper_unavailable'
  | 'secure_store_request_timeout'
  | 'secure_store_client_closed'
  | 'secure_store_parent_unsupported';
