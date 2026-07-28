import { describe, expect, test } from 'bun:test';
import * as publicEntry from '@forgeax/platform-io';

type PublicEntry = Record<string, unknown>;

const substrate = publicEntry as PublicEntry;

function getFunction(name: string): (...args: any[]) => unknown {
  const value = substrate[name];
  expect(typeof value).toBe('function');
  return value as (...args: any[]) => unknown;
}

describe('resource substrate public contract', () => {
  test('publishes a versioned capability index and complete public type names', () => {
    const index = substrate.RESOURCE_SUBSTRATE_CAPABILITY_INDEX as {
      version?: unknown;
      capabilities?: unknown;
      publicTypes?: unknown;
    };

    expect(index).toMatchObject({ version: 'resource-substrate.v1' });
    expect(index.capabilities).toEqual(
      expect.arrayContaining(['root', 'mutation', 'revision', 'trash', 'observer']),
    );
    expect(index.publicTypes).toEqual(
      expect.arrayContaining([
        'ResourceRoot',
        'ResourceMutation',
        'ResourceRevision',
        'ResourceTrashEntry',
        'ResourceObserverEvent',
        'ResourceStore',
        'ResourceResult',
        'ResourceError',
      ]),
    );
  });

  test('normalizes valid POSIX-like logical ids and rejects boundary paths', () => {
    const normalizeResourceId = getFunction('normalizeResourceId');
    const valid = normalizeResourceId('scenes/main.pack');
    expect(valid).toMatchObject({ ok: true, value: 'scenes/main.pack' });

    for (const input of [
      '',
      '/absolute/path',
      '../outside',
      'scenes/../../outside',
      'scenes//main.pack',
      'scenes/./main.pack',
      'scenes/main\\pack',
      'scenes/main\0.pack',
      '.resource-substrate/HEAD',
    ]) {
      const result = normalizeResourceId(input);
      expect(result).toMatchObject({ ok: false });
      if (result && typeof result === 'object' && 'error' in result) {
        const error = result.error as Record<string, unknown>;
        expect(['invalid-resource-id', 'root-boundary-violation']).toContain(error.code as string);
        expect(typeof error.hint).toBe('string');
        expect(typeof error.retryable).toBe('boolean');
        expect(error.message).toBeDefined();
      }
    }
  });

  test('exposes structured stale, identity, and storage errors without message parsing', () => {
    const createResourceError = getFunction('createResourceError');
    const scenarios = [
      {
        code: 'stale-revision',
        facts: { rootId: 'game-main', expected: 'rev-a', actual: 'rev-b' },
      },
      {
        code: 'identity-conflict',
        facts: { rootId: 'game-main', mutationIdentity: 'save-1' },
      },
      {
        code: 'storage-failure',
        facts: { rootId: 'game-main', retryable: true },
      },
    ];

    for (const scenario of scenarios) {
      const error = createResourceError(scenario.code, scenario.facts) as Record<string, unknown>;
      expect(error.code).toBe(scenario.code);
      expect(typeof error.hint).toBe('string');
      expect(typeof error.retryable).toBe('boolean');
      expect(error.message).toBeDefined();
    }
  });
});
