import type { RepositoryIdentity } from './root';
import { assertCanonicalRepositoryRoot } from './root';
import { withRepositoryLock } from './lock';
import { checkoutDetached, type CheckoutInput, type CheckoutResult } from './checkout';
import { initializeRepository, type InitializeResult } from './init';

export interface VersionControlService {
  readonly repository: RepositoryIdentity;
  withWriteLock<T>(operation: () => Promise<T>): Promise<T>;
  checkout(input: CheckoutInput): Promise<CheckoutResult>;
  initialize(): Promise<InitializeResult>;
}

export async function createVersionControlService(gameRoot: string): Promise<VersionControlService> {
  const repository = await assertCanonicalRepositoryRoot(gameRoot);
  return {
    repository,
    withWriteLock<T>(operation: () => Promise<T>) { return withRepositoryLock(repository.realPath, operation); },
    checkout(input) { return checkoutDetached(repository.path, input); },
    initialize() { return initializeRepository(repository.path); },
  };
}

export function createScopedVersionControlService(repository: RepositoryIdentity): VersionControlService {
  return { repository, withWriteLock<T>(operation: () => Promise<T>) { return withRepositoryLock(repository.realPath, operation); }, checkout(input) { return checkoutDetached(repository.path, input); }, initialize() { return initializeRepository(repository.path); } };
}
