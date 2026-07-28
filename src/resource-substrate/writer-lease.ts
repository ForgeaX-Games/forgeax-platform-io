/**
 * Root-scoped cross-process writer lease.
 *
 * The lease is intentionally conservative: an occupied or malformed record
 * blocks new mutations unless the previous PID is dead and prepared state is
 * known to be determinable.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve } from 'node:path';
import { createResourceError, type ResourceResult } from './contract';

export interface WriterLeaseOptions {
  readonly directory: string;
  readonly ownerPid?: number;
  readonly isProcessAlive?: (pid: number) => boolean | Promise<boolean>;
  readonly isPreparedStateDeterminate?: () => boolean | Promise<boolean>;
  readonly waitForActiveOwner?: boolean;
}

export interface WriterLeaseHandle {
  readonly ownerPid: number;
  readonly ownerNonce: string;
  release(): Promise<ResourceResult<void>>;
}

export interface WriterLeaseManager {
  acquire(): Promise<ResourceResult<WriterLeaseHandle>>;
}

interface LeaseRecord {
  readonly ownerPid: number;
  readonly ownerNonce: string;
}

export function createWriterLease(options: WriterLeaseOptions): WriterLeaseManager {
  const directory = resolve(options.directory);
  const lockPath = join(directory, '.writer.lock');
  const isProcessAlive = options.isProcessAlive ?? defaultIsProcessAlive;
  const isPreparedStateDeterminate = options.isPreparedStateDeterminate ?? (() => false);

  async function acquire(): Promise<ResourceResult<WriterLeaseHandle>> {
    try {
      await mkdir(directory, { recursive: true });
      const maxAttempts = options.waitForActiveOwner ? 200 : 2;
      for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
        const owner: LeaseRecord = {
          ownerPid: options.ownerPid ?? process.pid,
          ownerNonce: randomUUID(),
        };
        try {
          const handle = await open(
            lockPath,
            constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
            0o600,
          );
          await handle.writeFile(JSON.stringify(owner));
          await handle.close();
          return {
            ok: true,
            value: {
              ...owner,
              async release() {
                return release(owner);
              },
            },
          };
        } catch {
          const existing = await readLease();
          if (!existing) {
            if (options.waitForActiveOwner) {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
              continue;
            }
            return blocked('The writer lease record is unreadable.');
          }
          if (await isProcessAlive(existing.ownerPid)) {
            if (options.waitForActiveOwner) {
              await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
              continue;
            }
            return blocked('Another writer is still active.');
          }
          if (!(await isPreparedStateDeterminate())) {
            return blocked('The previous writer is gone but prepared state is unknown.');
          }
          await rm(lockPath, { force: true });
        }
      }
      return blocked('The writer lease could not be acquired safely.');
    } catch (error) {
      return {
        ok: false,
        error: createResourceError('storage-failure', {
          storageReason: error instanceof Error ? error.message : String(error),
          retryable: true,
        }),
      };
    }
  }

  async function release(owner: LeaseRecord): Promise<ResourceResult<void>> {
    try {
      const existing = await readLease();
      if (existing?.ownerNonce === owner.ownerNonce) await rm(lockPath, { force: true });
      return { ok: true, value: undefined };
    } catch (error) {
      return {
        ok: false,
        error: createResourceError('storage-failure', {
          storageReason: error instanceof Error ? error.message : String(error),
          retryable: true,
        }),
      };
    }
  }

  async function readLease(): Promise<LeaseRecord | null> {
    try {
      return JSON.parse(await readFile(lockPath, 'utf8')) as LeaseRecord;
    } catch {
      return null;
    }
  }

  function blocked(reason: string): ResourceResult<never> {
    return {
      ok: false,
      error: createResourceError('recovery-required', {
        storageReason: reason,
        retryable: false,
      }),
    };
  }

  return { acquire };
}

function defaultIsProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
