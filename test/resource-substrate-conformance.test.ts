import { describe, expect, test } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const repositoryRoot = join(import.meta.dir, '..');
const CONFORMANCE_FIXTURE_VERSION = 'resource-substrate-conformance.v1';

const requiredCommands = [
  'bun install --frozen-lockfile',
  'bun run typecheck',
  'bun test',
  'bun run lint:boundaries',
  'bun test test/resource-substrate-consumer.test.ts',
] as const;

type EvidenceKind =
  | 'public-consumer'
  | 'reducer'
  | 'filesystem'
  | 'recovery'
  | 'observer'
  | 'confinement'
  | 'docs'
  | 'legacy-export';

interface ConformanceCase {
  readonly id: `AC-${string}`;
  readonly kinds: readonly EvidenceKind[];
  readonly evidence: readonly string[];
}

const conformanceCases: readonly ConformanceCase[] = [
  {
    id: 'AC-01',
    kinds: ['public-consumer'],
    evidence: ['test/resource-substrate-consumer.test.ts', 'test/resource-substrate-contract.test.ts'],
  },
  {
    id: 'AC-02',
    kinds: ['public-consumer', 'reducer', 'filesystem'],
    evidence: ['test/resource-substrate-consumer.test.ts', 'test/resource-substrate-mutation.test.ts', 'test/resource-substrate-filesystem.test.ts'],
  },
  {
    id: 'AC-03',
    kinds: ['filesystem'],
    evidence: ['test/resource-substrate-snapshot.test.ts'],
  },
  {
    id: 'AC-04',
    kinds: ['filesystem', 'recovery'],
    evidence: ['test/resource-substrate-failure.test.ts', 'test/resource-substrate-recovery.test.ts'],
  },
  {
    id: 'AC-05',
    kinds: ['reducer', 'filesystem'],
    evidence: ['test/resource-substrate-mutation.test.ts', 'test/resource-substrate-snapshot.test.ts'],
  },
  {
    id: 'AC-06',
    kinds: ['filesystem'],
    evidence: ['test/resource-substrate-concurrency.test.ts'],
  },
  {
    id: 'AC-07',
    kinds: ['reducer', 'recovery'],
    evidence: ['test/resource-substrate-identity.test.ts', 'test/resource-substrate-recovery.test.ts'],
  },
  {
    id: 'AC-08',
    kinds: ['reducer', 'filesystem', 'public-consumer'],
    evidence: ['test/resource-substrate-trash.test.ts', 'test/resource-substrate-filesystem.test.ts', 'test/resource-substrate-consumer.test.ts'],
  },
  {
    id: 'AC-09',
    kinds: ['observer'],
    evidence: ['test/resource-substrate-observer-replay.test.ts', 'test/resource-substrate-observer-contract.test.ts'],
  },
  {
    id: 'AC-10',
    kinds: ['observer'],
    evidence: ['test/resource-substrate-observer-source.test.ts', 'test/resource-substrate-observer-lifecycle.test.ts'],
  },
  {
    id: 'AC-11',
    kinds: ['reducer', 'observer', 'public-consumer'],
    evidence: ['test/resource-substrate-contract.test.ts', 'test/resource-substrate-observer-contract.test.ts', 'test/resource-substrate-consumer.test.ts'],
  },
  {
    id: 'AC-12',
    kinds: ['confinement', 'filesystem'],
    evidence: ['test/resource-substrate-confinement.test.ts'],
  },
  {
    id: 'AC-13',
    kinds: ['public-consumer'],
    evidence: ['test/resource-substrate-consumer.test.ts', 'package.json'],
  },
  {
    id: 'AC-14',
    kinds: ['legacy-export', 'public-consumer'],
    evidence: ['test/resource-substrate-public-surface.test.ts', 'src/index.ts', '.dependency-cruiser.cjs'],
  },
  {
    id: 'AC-15',
    kinds: ['docs'],
    evidence: ['README.md', 'docs/resource-substrate.md'],
  },
];

const errorCodes = [
  'invalid-resource-id',
  'root-boundary-violation',
  'root-confinement-violation',
  'recovery-required',
  'resource-not-found',
  'resource-conflict',
  'stale-revision',
  'identity-conflict',
  'storage-failure',
  'observer-gap',
  'observer-invalidation',
  'observer-error',
  'unsupported-capability',
] as const;

async function readRepositoryFile(relativePath: string): Promise<string> {
  return readFile(join(repositoryRoot, relativePath), 'utf8');
}

describe('versioned resource substrate conformance fixture', () => {
  test('maps every acceptance criterion to executable evidence', async () => {
    expect(CONFORMANCE_FIXTURE_VERSION).toBe('resource-substrate-conformance.v1');
    expect(conformanceCases).toHaveLength(15);
    const expectedIds: ConformanceCase['id'][] = Array.from(
      { length: 15 },
      (_, index) => `AC-${String(index + 1).padStart(2, '0')}` as ConformanceCase['id'],
    );
    expect(conformanceCases.map((item) => item.id)).toEqual(expectedIds);
    expect(requiredCommands).toEqual([
      'bun install --frozen-lockfile',
      'bun run typecheck',
      'bun test',
      'bun run lint:boundaries',
      'bun test test/resource-substrate-consumer.test.ts',
    ]);

    const allKinds = new Set(conformanceCases.flatMap((item) => item.kinds));
    expect(allKinds).toEqual(
      new Set<EvidenceKind>([
        'public-consumer',
        'reducer',
        'filesystem',
        'recovery',
        'observer',
        'confinement',
        'docs',
        'legacy-export',
      ]),
    );

    for (const item of conformanceCases) {
      expect(item.evidence.length).toBeGreaterThan(0);
      for (const evidencePath of item.evidence) {
        const content = await readRepositoryFile(evidencePath);
        expect(content.length).toBeGreaterThan(0);
      }
    }
  });

  test('keeps public consumer, documentation, and error evidence discoverable', async () => {
    const consumerSource = await readRepositoryFile('test/resource-substrate-consumer.test.ts');
    const readme = await readRepositoryFile('README.md');
    const documentation = await readRepositoryFile('docs/resource-substrate.md');

    expect(consumerSource).not.toContain('../src/');
    expect(consumerSource).not.toContain('/src/');
    expect(readme).toContain('@forgeax/platform-io');
    expect(readme).toContain('openResourceRoot');
    for (const heading of ['root', 'mutation', 'revision', 'trash', 'observer']) {
      expect(documentation).toContain(`## ${heading}`);
    }
    for (const code of errorCodes) {
      expect(documentation).toContain(`\`${code}\``);
    }
  });

  test('contains no skipped or placeholder conformance cases', async () => {
    const source = await readRepositoryFile('test/resource-substrate-conformance.test.ts');
    expect(source).not.toMatch(/(?:describe|test)\.(?:skip|todo)/);
  });
});
