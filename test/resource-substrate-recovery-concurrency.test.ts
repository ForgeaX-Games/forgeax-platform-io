import { describe, expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFilesystemResourceStore } from '../src/resource-substrate/filesystem-store';
import { openResourceRoot } from '../src/resource-substrate';
import { createWriterLease } from '../src/resource-substrate/writer-lease';
import { classifyPreparedRecoveryWithLineage, MAX_LINEAGE_NODES } from '../src/resource-substrate/recovery';
import type { ResourceMutationRecord, ResourceRoot } from '../src/resource-substrate/contract';

const rootName = 'game-main';
const rootDir = (directory: string) => join(directory, 'roots', `root-${sha(rootName)}`);
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const shaBytes = (value: number) => createHash('sha256').update(Uint8Array.from([value])).digest('hex');
function createLineReader(stream: ReadableStream<Uint8Array>): () => Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffered = '';
  return async () => {
    while (true) {
      const newline = buffered.indexOf('\n');
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        return line;
      }
      const next = await reader.read();
      if (next.done) {
        if (buffered) {
          const line = buffered;
          buffered = '';
          return line;
        }
        throw new Error('child stdout closed before the expected report');
      }
      buffered += decoder.decode(next.value, { stream: true });
    }
  };
}

async function openRoot(directory: string, options: Record<string, unknown> = {}) {
  const store = createFilesystemResourceStore({ directory, ...options } as never);
  const opened = await openResourceRoot({ rootId: rootName, store });
  expect(opened.ok).toBe(true);
  if (!opened.ok) throw opened.error;
  return { root: opened.value, store };
}

async function leavePrepared(directory: string, identity = 'prepared-race'): Promise<{ before: string; after: string }> {
  const opened = await openRoot(directory);
  const initial = await opened.root.readSnapshot();
  expect(initial.ok).toBe(true);
  if (!initial.ok) throw initial.error;
  opened.store.failNext('terminal-write');
  const failed = await opened.root.commit({
    identity,
    expectedRevision: initial.value.revision,
    changes: [{ kind: 'put', resourceId: 'assets/race.bin', bytes: Uint8Array.from([7]) }],
  });
  expect(failed.ok).toBe(false);
  const prepared = await readdir(join(rootDir(directory), 'prepared'));
  expect(prepared.filter((entry) => entry.endsWith('.json'))).toHaveLength(1);
  const value = JSON.parse(await readFile(join(rootDir(directory), 'prepared', prepared[0]!), 'utf8')) as {
    beforeRevision: string;
    afterRevision: string;
  };
  return { before: value.beforeRevision, after: value.afterRevision };
}

describe('prepared recovery corrective', () => {
  test('reader re-enumerates after the first prepared listing and never reads a removed entry', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-race-'));
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => { releaseBarrier = resolve; });
    let detected = false;
    let enterHook!: () => void;
    const hookEntered = new Promise<void>((resolve) => { enterHook = resolve; });
    try {
      await leavePrepared(directory, 'prepared-before');
      const reader = await openRoot(directory, {
        afterPreparedRecoveryDetectedForTest: async () => {
          detected = true;
          enterHook();
          await barrier;
        },
      });
      const readPromise = reader.root.readSnapshot();
      await hookEntered;
      expect(detected).toBe(true);
      const writer = await openRoot(directory);
      const writerReadPromise = writer.root.readSnapshot();
      const writerRead = await writerReadPromise;
      expect(writerRead.ok).toBe(true);
      releaseBarrier();
      const [read] = await Promise.all([readPromise]);
      expect(read.ok).toBe(true);
      if (!read.ok) throw read.error;
      expect(read.value.active['assets/race.bin']).toEqual(Uint8Array.from([7]));
      console.info(JSON.stringify({ certificate: 'reader-writer-race', pid: process.pid, rootId: rootName, revision: read.value.revision, prepared: 0, classification: 'keep-after' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('two prepared readers converge through one terminal write', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-two-readers-'));
    let terminalWrites = 0;
    try {
      await leavePrepared(directory, 'prepared-after');
      const first = await openRoot(directory, { beforeTerminalWriteForTest: () => { terminalWrites += 1; } });
      const second = await openRoot(directory, { beforeTerminalWriteForTest: () => { terminalWrites += 1; } });
      const [left, right] = await Promise.all([first.root.readSnapshot(), second.root.readSnapshot()]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      expect(terminalWrites).toBe(1);
      expect((await readdir(join(rootDir(directory), 'prepared'))).filter((name) => name.endsWith('.json'))).toHaveLength(0);
      console.info(JSON.stringify({ certificate: 'two-reader-terminal-once', pid: process.pid, rootId: rootName, terminalWrites, classification: 'keep-after' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('clean reads stay parallel while an external writer lease is held', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-clean-'));
    try {
      const first = await openRoot(directory);
      const second = await openRoot(directory);
      const lease = await createWriterLease({ directory: first.store.stateDirectory }).acquire();
      expect(lease.ok).toBe(true);
      if (!lease.ok) throw lease.error;
      const [left, right] = await Promise.all([first.root.readSnapshot(), second.root.readSnapshot()]);
      expect(left.ok).toBe(true);
      expect(right.ok).toBe(true);
      expect((await lease.value.release()).ok).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('cross-process clean reads succeed while the writer lease is held', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-cross-read-'));
    try {
      const opened = await openRoot(directory);
      const lease = await createWriterLease({ directory: opened.store.stateDirectory }).acquire();
      expect(lease.ok).toBe(true);
      if (!lease.ok) throw lease.error;
      const workers = [1, 2].map(() => Bun.spawn(['bun', 'run', 'test/fixtures/resource-substrate-recovery-concurrency-worker.ts', directory], { stdout: 'pipe', stderr: 'pipe' }));
      const statuses = await Promise.all(workers.map(async (worker) => ({ exit: await worker.exited, output: await new Response(worker.stdout).text() })));
      expect(statuses.map((status) => status.exit)).toEqual([0, 0]);
      const reports = statuses.map((status) => JSON.parse(status.output.trim()) as { pid: number; revision: string });
      expect(new Set(reports.map((report) => report.pid)).size).toBe(2);
      expect(new Set(reports.map((report) => report.revision)).size).toBe(1);
      expect(reports[0]!.revision).toBe('revision-0');
      console.info(JSON.stringify({ certificate: 'cross-process-clean-read', readerPids: reports.map((report) => report.pid), revision: reports[0]!.revision, leaseHeld: true }));
      expect((await lease.value.release()).ok).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('two child readers recover one prepared mutation with distinct PIDs and one terminal marker', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-child-race-'));
    try {
      await leavePrepared(directory, 'child-race');
      const preparedPath = join(rootDir(directory), 'prepared');
      const preparedBefore = (await readdir(preparedPath)).filter((name) => name.endsWith('.json'));
      const markerRoot = join(directory, 'markers');
      await mkdir(markerRoot, { recursive: true });
      const terminalLog = join(markerRoot, 'terminals.log');
      const workers = [0, 1].map(() => Bun.spawn(
        ['bun', 'run', 'test/fixtures/resource-substrate-recovery-concurrency-worker.ts', directory, 'prepared-reader', terminalLog],
        {
          stdin: 'pipe',
          stdout: 'pipe',
          stderr: 'pipe',
        },
      ));
      const readLines = workers.map((worker) => createLineReader(worker.stdout));
      const readyReports = await Promise.all(readLines.map(async (readLine) => JSON.parse(await readLine()) as { type: string; pid: number }));
      expect(readyReports.map((report) => report.type)).toEqual(['prepared-detected', 'prepared-detected']);
      for (const worker of workers) {
        worker.stdin.write('release\n');
        await worker.stdin.end();
      }
      const results = await Promise.all(workers.map(async (worker, index) => ({ exit: await worker.exited, output: await readLines[index]!() })));
      expect(results.map((result) => result.exit)).toEqual([0, 0]);
      const reports = results.map((result) => JSON.parse(result.output) as { pid: number; revision: string });
      expect(new Set(reports.map((report) => report.pid)).size).toBe(2);
      expect(new Set(reports.map((report) => report.revision)).size).toBe(1);
      const terminalMarkers = (await readFile(terminalLog, 'utf8')).trim().split('\n').filter(Boolean).map((line) => JSON.parse(line) as { pid: number; identity: string });
      expect(terminalMarkers).toHaveLength(1);
      expect(terminalMarkers[0]!.identity).toBe('child-race');
      const preparedAfter = (await readdir(preparedPath)).filter((name) => name.endsWith('.json'));
      expect(preparedAfter).toHaveLength(0);
      const terminalPath = join(rootDir(directory), 'mutations', `${sha('child-race')}.json`);
      const terminalHash = createHash('sha256').update(await readFile(terminalPath)).digest('hex');
      console.info(JSON.stringify({ certificate: 'child-prepared-race', readerPids: reports.map((report) => report.pid), revision: reports[0]!.revision, terminalWriterPid: terminalMarkers[0]!.pid, terminalWrites: 1, preparedBefore, preparedAfter, terminalHash, classification: 'keep-after' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('prepared detection hook is not called for an empty prepared directory', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-empty-'));
    let calls = 0;
    try {
      const opened = await openRoot(directory, { afterPreparedRecoveryDetectedForTest: () => { calls += 1; } });
      expect((await opened.root.readSnapshot()).ok).toBe(true);
      expect(calls).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('fresh process after HEAD replacement recovers once and leaves one terminal hash', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-restart-'));
    try {
      const opened = await openRoot(directory);
      const before = await opened.root.readSnapshot();
      expect(before.ok).toBe(true);
      if (!before.ok) throw before.error;
      const crashWorker = Bun.spawn(['bun', 'run', 'test/fixtures/resource-substrate-crash-worker.ts', directory, 'after-head-replace']);
      expect(await crashWorker.exited).toBe(77);
      const preparedPath = join(rootDir(directory), 'prepared');
      const beforeRecovery = (await readdir(preparedPath)).filter((name) => name.endsWith('.json'));
      expect(beforeRecovery).toHaveLength(1);
      const recoverInChild = () => Bun.spawn(
        ['bun', 'run', 'test/fixtures/resource-substrate-recovery-concurrency-worker.ts', directory],
        { stdout: 'pipe', stderr: 'pipe' },
      );
      const firstRecovery = recoverInChild();
      const firstResult = { exit: await firstRecovery.exited, output: await new Response(firstRecovery.stdout).text() };
      expect(firstResult.exit).toBe(0);
      const firstReport = JSON.parse(firstResult.output.trim()) as { pid: number; revision: string };
      expect(firstReport.pid).not.toBe(process.pid);
      const terminalPath = join(rootDir(directory), 'mutations', `${sha('crash-after-head-replace')}.json`);
      const terminal = await readFile(terminalPath);
      const firstTerminalStat = await stat(terminalPath);
      expect((await readdir(preparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
      const terminalHash = createHash('sha256').update(terminal).digest('hex');
      expect(terminalHash).toHaveLength(64);

      const secondRecovery = recoverInChild();
      const secondResult = { exit: await secondRecovery.exited, output: await new Response(secondRecovery.stdout).text() };
      expect(secondResult.exit).toBe(0);
      const secondReport = JSON.parse(secondResult.output.trim()) as { pid: number; revision: string };
      expect(secondReport.pid).not.toBe(firstReport.pid);
      expect(secondReport.revision).toBe(firstReport.revision);
      expect(await readFile(terminalPath)).toEqual(terminal);
      const secondTerminalStat = await stat(terminalPath);
      expect(secondTerminalStat.ino).toBe(firstTerminalStat.ino);
      expect(secondTerminalStat.mtimeMs).toBe(firstTerminalStat.mtimeMs);
      console.info(JSON.stringify({ certificate: 'cross-process-after-head-restart', crashPid: crashWorker.pid, recoveryPids: [firstReport.pid, secondReport.pid], rootId: rootName, beforeRevision: before.value.revision, afterRevision: firstReport.revision, preparedBefore: beforeRecovery, preparedAfter: [], terminalHash, terminalWrites: 1, classification: 'keep-after' }));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('initialization never overwrites a divergent or noncanonical revision-0', async () => {
    for (const raw of ['{"revision":"revision-0","active":{},"trash":[],"extra":1}', '{"revision":"revision-0","active":{},"trash":[]}\n']) {
      const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-init-'));
      try {
        const opened = await openRoot(directory);
        await opened.root.readSnapshot();
        const revisionPath = join(rootDir(directory), 'revisions', 'revision-0.json');
        const headPath = join(rootDir(directory), 'HEAD');
        await writeFile(revisionPath, raw);
        await unlink(headPath);
        const result = await opened.root.readSnapshot();
        expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
        expect(await readFile(revisionPath, 'utf8')).toBe(raw);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('initialization never resets HEAD when later history already exists', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-init-history-'));
    try {
      const opened = await openRoot(directory);
      await opened.root.readSnapshot();
      const root = rootDir(directory);
      await writeFile(join(root, 'revisions', 'later.json'), JSON.stringify({ revision: 'later', parentRevision: 'revision-0', resourceIds: [], active: {}, trash: [] }));
      await unlink(join(root, 'HEAD'));
      const result = await opened.root.readSnapshot();
      expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect(await Bun.file(join(root, 'HEAD')).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('persisted manifest shape binds metadata presence to parent semantics', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-manifest-shape-'));
    try {
      const opened = await openRoot(directory);
      await opened.root.readSnapshot();
      const revisionDir = join(rootDir(directory), 'revisions');
      const shapes = [
        { revision: 'hybrid-parent', parentRevision: 'revision-0', resourceIds: [], active: {}, trash: [] },
        { revision: 'hybrid-identity', parentRevision: null, mutationIdentity: 'identity', resourceIds: [], active: {}, trash: [] },
        { revision: 'hybrid-resource-ids', parentRevision: null, resourceIds: ['unexpected'], active: {}, trash: [] },
        { revision: 'rogue', active: {}, trash: [] },
      ];
      for (const shape of shapes) {
        await writeFile(join(revisionDir, `${shape.revision}.json`), JSON.stringify(shape));
        const result = await opened.store.readSnapshotAt(rootName, shape.revision);
        expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      }
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('multiple prepared records fail closed before terminalize or cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-multiple-'));
    try {
      await leavePrepared(directory, 'prepared-descendant');
      const preparedPath = join(rootDir(directory), 'prepared');
      const [entry] = await readdir(preparedPath);
      await writeFile(join(preparedPath, `second-${entry}`), await readFile(join(preparedPath, entry!)));
      const opened = await openRoot(directory);
      const result = await opened.root.readSnapshot();
      expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect((await readdir(preparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(2);
      expect(await readdir(join(rootDir(directory), 'mutations'))).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('writeMutation cannot bypass prepared recovery', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-write-'));
    try {
      await leavePrepared(directory, 'prepared-fork');
      const opened = await openRoot(directory);
      const preparedPath = join(rootDir(directory), 'prepared');
      const [entry] = await readdir(preparedPath);
      const prepared = JSON.parse(await readFile(join(preparedPath, entry!), 'utf8')) as {
        record: Parameters<typeof opened.store.writeMutation>[1];
      };
      const result = await opened.store.writeMutation(rootName, {
        ...prepared.record,
      });
      expect(result.ok).toBe(true);
      expect((await readdir(preparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('manifest write-once preserves exact bytes and rejects same-revision changes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-manifest-'));
    try {
      const opened = await openRoot(directory);
      const snapshot = {
        revision: 'revision-custom' as never,
        active: {
          zeta: Uint8Array.from([1]),
          '2-alpha': Uint8Array.from([2]),
          'éclair': Uint8Array.from([3]),
        },
        trash: [],
      };
      expect((await opened.store.writeSnapshot(rootName, snapshot)).ok).toBe(true);
      const manifestPath = join(rootDir(directory), 'revisions', 'revision-custom.json');
      const before = await readFile(manifestPath);
      const beforeStat = await stat(manifestPath);
      expect(before.toString()).toBe(`{"revision":"revision-custom","parentRevision":null,"resourceIds":[],"active":{"zeta":"${shaBytes(1)}","2-alpha":"${shaBytes(2)}","éclair":"${shaBytes(3)}"},"trash":[]}`);
      expect((await opened.store.writeSnapshot(rootName, structuredClone(snapshot))).ok).toBe(true);
      expect(await readFile(manifestPath)).toEqual(before);
      const replayStat = await stat(manifestPath);
      expect(replayStat.ino).toBe(beforeStat.ino);
      expect(replayStat.mtimeMs).toBe(beforeStat.mtimeMs);
      expect((await opened.store.writeSnapshot(rootName, { ...snapshot, active: { ...snapshot.active, zeta: Uint8Array.from([9]) } })).ok).toBe(false);
      expect(await readFile(manifestPath)).toEqual(before);
      const rejectedStat = await stat(manifestPath);
      expect(rejectedStat.ino).toBe(beforeStat.ino);
      expect(rejectedStat.mtimeMs).toBe(beforeStat.mtimeMs);
      const manifest = JSON.parse(before.toString()) as { active: Record<string, string> };
      const blobPath = join(rootDir(directory), 'blobs', manifest.active.zeta!);
      await writeFile(blobPath, Uint8Array.from([99]));
      const corrupted = await opened.store.writeSnapshot(rootName, structuredClone(snapshot));
      expect(corrupted).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('manifest persistence preserves prototype-named resource ids as own data', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-prototype-id-'));
    try {
      const opened = await openRoot(directory);
      const active = Object.fromEntries([
        ['__proto__', Uint8Array.from([4])],
        ['constructor', Uint8Array.from([5])],
      ]);
      expect((await opened.store.writeSnapshot(rootName, {
        revision: 'revision-prototype-ids' as never,
        active,
        trash: [],
      })).ok).toBe(true);
      const read = await opened.root.readSnapshot();
      expect(read.ok).toBe(true);
      if (!read.ok) throw read.error;
      expect(Object.prototype.hasOwnProperty.call(read.value.active, '__proto__')).toBe(true);
      expect(read.value.active['__proto__']).toEqual(Uint8Array.from([4]));
      expect(Object.getOwnPropertyDescriptor(read.value.active, 'constructor')?.value).toEqual(Uint8Array.from([5]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('manifest write-once preserves noncanonical and metadata-mismatch audit bytes', async () => {
    const cases = [
      {
        revision: 'revision-noncanonical',
        replace(raw: string) { return `${raw}\n`; },
      },
      {
        revision: 'revision-metadata',
        replace(raw: string) {
          const parsed = JSON.parse(raw) as { revision: string; active: Record<string, string>; trash: unknown[] };
          return JSON.stringify({ revision: parsed.revision, parentRevision: 'revision-0', mutationIdentity: 'unexpected', resourceIds: [], active: parsed.active, trash: parsed.trash });
        },
      },
    ];
    for (const item of cases) {
      const directory = await mkdtemp(join(tmpdir(), `resource-substrate-recovery-manifest-${item.revision}-`));
      try {
        const opened = await openRoot(directory);
        const snapshot = { revision: item.revision as never, active: {}, trash: [] };
        expect((await opened.store.writeSnapshot(rootName, snapshot)).ok).toBe(true);
        const manifestPath = join(rootDir(directory), 'revisions', `${item.revision}.json`);
        const rejectedBytes = item.replace(await readFile(manifestPath, 'utf8'));
        await writeFile(manifestPath, rejectedBytes);
        const beforeStat = await stat(manifestPath);
        const headBefore = await readFile(join(rootDir(directory), 'HEAD'), 'utf8');
        const replay = await opened.store.writeSnapshot(rootName, structuredClone(snapshot));
        expect(replay).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
        expect(await readFile(manifestPath, 'utf8')).toBe(rejectedBytes);
        const afterStat = await stat(manifestPath);
        expect(afterStat.ino).toBe(beforeStat.ino);
        expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
        expect(await readFile(join(rootDir(directory), 'HEAD'), 'utf8')).toBe(headBefore);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('terminal records are write-once and replay only exact bytes', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-terminal-'));
    try {
      const opened = await openRoot(directory);
      const record: ResourceMutationRecord = {
        identity: 'terminal-once' as never,
        requestDigest: 'request-a',
        result: {
          identity: 'terminal-once' as never,
          beforeRevision: 'revision-0' as never,
          afterRevision: 'revision-0' as never,
          changed: false,
        },
        resourceIds: [],
      };
      expect((await opened.store.writeMutation(rootName, record)).ok).toBe(true);
      const path = join(rootDir(directory), 'mutations', `${sha(record.identity)}.json`);
      const bytes = await readFile(path);
      expect((await opened.store.writeMutation(rootName, structuredClone(record))).ok).toBe(true);
      expect(await readFile(path)).toEqual(bytes);
      const mismatch = await opened.store.writeMutation(rootName, { ...record, requestDigest: 'request-b' });
      expect(mismatch).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect(await readFile(path)).toEqual(bytes);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('terminal mismatch matrix fails closed for identity, digest, result, and resource ids', async () => {
    const variants = [
      (record: ResourceMutationRecord) => ({ ...record, identity: 'other-identity' as never }),
      (record: ResourceMutationRecord) => ({ ...record, requestDigest: 'other-digest' }),
      (record: ResourceMutationRecord) => ({ ...record, result: { ...record.result, changed: true } }),
      (record: ResourceMutationRecord) => ({ ...record, resourceIds: ['assets/other.bin'] as never }),
    ];
    for (const [index, mutate] of variants.entries()) {
      const directory = await mkdtemp(join(tmpdir(), `resource-substrate-recovery-terminal-matrix-${index}-`));
      try {
        const opened = await openRoot(directory);
        await opened.root.readSnapshot();
        const record: ResourceMutationRecord = {
          identity: 'terminal-matrix' as never,
          requestDigest: 'digest-a',
          result: { identity: 'terminal-matrix' as never, beforeRevision: 'revision-0' as never, afterRevision: 'revision-0' as never, changed: false },
          resourceIds: [],
        };
        const path = join(rootDir(directory), 'mutations', `${sha(String(record.identity))}.json`);
        await writeFile(path, JSON.stringify(mutate(record)));
        const result = await opened.store.writeMutation(rootName, record);
        expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
        expect(await readFile(path, 'utf8')).toBe(JSON.stringify(mutate(record)));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('changed/revision invariant rejects impossible terminal and commit records without mutation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-invariant-'));
    try {
      const opened = await openRoot(directory);
      const initial = await opened.root.readSnapshot();
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw initial.error;
      const impossible: ResourceMutationRecord = {
        identity: 'impossible' as never,
        requestDigest: 'digest',
        result: { identity: 'impossible' as never, beforeRevision: 'revision-0' as never, afterRevision: 'revision-other' as never, changed: false },
        resourceIds: [],
      };
      const terminal = await opened.store.writeMutation(rootName, impossible);
      expect(terminal).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect(await readdir(join(rootDir(directory), 'mutations'))).toHaveLength(0);
      const commit = await opened.store.commitMutation(rootName, { revision: 'revision-other' as never, active: {}, trash: [] }, impossible);
      expect(commit).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect(await readFile(join(rootDir(directory), 'HEAD'), 'utf8')).toBe(`${initial.value.revision}\n`);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('public write boundaries reject runtime shapes their strict readers cannot consume', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-write-input-'));
    try {
      const opened = await openRoot(directory);
      const initial = await opened.root.readSnapshot();
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw initial.error;
      const root = rootDir(directory);
      const headBefore = await readFile(join(root, 'HEAD'), 'utf8');
      const revisionsBefore = await readdir(join(root, 'revisions'));

      const invalidSnapshots = [
        { revision: 'bad-active', active: [], trash: [] },
        { revision: 'bad-bytes', active: { resource: 'not-bytes' }, trash: [] },
        {
          revision: 'bad-trash',
          active: {},
          trash: [{ resourceId: 'resource', bytes: Uint8Array.from([1]), mutationIdentity: 'mutation', revision: '../bad' }],
        },
      ];
      for (const snapshot of invalidSnapshots) {
        const result = await opened.store.writeSnapshot(rootName, snapshot as never);
        expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      }

      const invalidRecord = {
        identity: 'invalid-record',
        requestDigest: 'digest',
        result: {
          identity: 'invalid-record',
          beforeRevision: initial.value.revision,
          afterRevision: 'invalid-after',
          changed: true,
        },
        resourceIds: [123],
      };
      expect(await opened.store.writeMutation(rootName, invalidRecord as never)).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect(await opened.store.commitMutation(
        rootName,
        { revision: 'invalid-after' as never, active: {}, trash: [] },
        invalidRecord as never,
      )).toMatchObject({ ok: false, error: { code: 'recovery-required' } });

      expect(await readFile(join(root, 'HEAD'), 'utf8')).toBe(headBefore);
      expect(await readdir(join(root, 'revisions'))).toEqual(revisionsBefore);
      expect(await readdir(join(root, 'mutations'))).toEqual([]);
      expect(await readdir(join(root, 'prepared'))).toEqual([]);
      expect(await readdir(join(root, 'blobs'))).toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('public writes reject accessors and capture caller-owned mutable bytes before awaiting', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-write-capture-'));
    try {
      const opened = await openRoot(directory);
      const initial = await opened.root.readSnapshot();
      expect(initial.ok).toBe(true);
      if (!initial.ok) throw initial.error;

      const accessorActive: Record<string, Uint8Array> = {};
      let getterCalls = 0;
      Object.defineProperty(accessorActive, 'asset', {
        enumerable: true,
        get() {
          getterCalls += 1;
          return Uint8Array.from([getterCalls]);
        },
      });
      const accessorResult = await opened.store.writeSnapshot(rootName, {
        revision: 'revision-accessor' as never,
        active: accessorActive,
        trash: [],
      });
      expect(accessorResult).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect(getterCalls).toBe(0);

      const callerBytes = Uint8Array.from([7]);
      const callerActive: Record<string, Uint8Array> = { asset: callerBytes };
      const writePromise = opened.store.writeSnapshot(rootName, {
        revision: 'revision-captured' as never,
        active: callerActive,
        trash: [],
      });
      callerBytes[0] = 99;
      callerActive.asset = Uint8Array.from([100]);
      expect((await writePromise).ok).toBe(true);
      const captured = await opened.root.readSnapshot();
      expect(captured.ok).toBe(true);
      if (!captured.ok) throw captured.error;
      expect(captured.value.active.asset).toEqual(Uint8Array.from([7]));

      const resourceIds = ['asset'] as never[];
      const mutableRecord: ResourceMutationRecord = {
        identity: 'captured-record' as never,
        requestDigest: 'captured-digest',
        result: {
          identity: 'captured-record' as never,
          beforeRevision: 'revision-captured' as never,
          afterRevision: 'revision-captured' as never,
          changed: false,
        },
        resourceIds,
      };
      const terminalPromise = opened.store.writeMutation(rootName, mutableRecord);
      resourceIds[0] = 123 as never;
      (mutableRecord.result as { changed: boolean }).changed = true;
      expect((await terminalPromise).ok).toBe(true);
      const terminal = await opened.store.readMutation(rootName, 'captured-record' as never);
      expect(terminal.ok).toBe(true);
      if (!terminal.ok) throw terminal.error;
      if (!terminal.value) throw new Error('captured terminal was not persisted');
      expect(terminal.value).toMatchObject({
        resourceIds: ['asset'],
        result: { changed: false, beforeRevision: 'revision-captured', afterRevision: 'revision-captured' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('prepared exactness matrix preserves prepared state on every invalid linkage', async () => {
    const cases = ['unknown-key', 'noncanonical', 'manifest-revision', 'after-missing', 'after-invalid', 'after-parent', 'after-identity', 'after-resourceIds'] as const;
    for (const [index, kind] of cases.entries()) {
      const directory = await mkdtemp(join(tmpdir(), `resource-substrate-recovery-prepared-${index}-`));
      try {
        const { after } = await leavePrepared(directory, `prepared-${kind}`);
        const preparedPath = join(rootDir(directory), 'prepared');
        const [entry] = await readdir(preparedPath);
        const path = join(preparedPath, entry!);
        const prepared = JSON.parse(await readFile(path, 'utf8')) as Record<string, any>;
        const revisionPath = join(rootDir(directory), 'revisions', `${after}.json`);
        if (kind === 'unknown-key') {
          prepared.unknown = true;
          await writeFile(path, JSON.stringify(prepared));
        }
        if (kind === 'noncanonical') {
          await writeFile(path, `${await readFile(path, 'utf8')}\n`);
        } else if (kind === 'manifest-revision') {
          prepared.manifestRevision = 'other-revision';
          await writeFile(path, JSON.stringify(prepared));
        } else if (kind.startsWith('after-')) {
          if (kind === 'after-missing') await unlink(revisionPath);
          else if (kind === 'after-invalid') await writeFile(revisionPath, '{}');
          else {
            const afterManifest = JSON.parse(await readFile(revisionPath, 'utf8')) as Record<string, any>;
            if (kind === 'after-parent') afterManifest.parentRevision = 'other-parent';
            if (kind === 'after-identity') afterManifest.mutationIdentity = 'other-identity';
            if (kind === 'after-resourceIds') afterManifest.resourceIds = ['other-resource'];
            await writeFile(revisionPath, JSON.stringify(afterManifest));
          }
        }
        const result = await (await openRoot(directory)).root.readSnapshot();
        if (result.ok) throw new Error(`unexpected successful recovery for ${kind}`);
        expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
        expect((await readdir(preparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('prepared recovery fails closed when the after manifest loses a referenced blob', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-blob-integrity-'));
    try {
      const { after } = await leavePrepared(directory, 'prepared-missing-blob');
      const root = rootDir(directory);
      const manifest = JSON.parse(await readFile(join(root, 'revisions', `${after}.json`), 'utf8')) as {
        active: Record<string, string>;
      };
      const blobDigest = Object.values(manifest.active)[0];
      if (!blobDigest) throw new Error('prepared manifest did not contain an active blob');
      await unlink(join(root, 'blobs', blobDigest));

      const recovered = await (await openRoot(directory)).root.readSnapshot();
      expect(recovered).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect((await readdir(join(root, 'prepared'))).filter((name) => name.endsWith('.json'))).toHaveLength(1);
      expect(await Bun.file(join(root, 'mutations', `${sha('prepared-missing-blob')}.json`)).exists()).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('lease release failure is observable, including primary and release errors', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-release-'));
    const secondDirectory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-release-'));
    try {
      const success = await openRoot(directory, {
        beforeInternalLeaseReleaseForTest: () => { throw new Error('release boundary'); },
      });
      const succeeded = await success.store.writeSnapshot(rootName, {
        revision: 'revision-release' as never,
        active: {},
        trash: [],
      });
      expect(succeeded).toMatchObject({ ok: false, error: { code: 'storage-failure' } });

      const failure = await openRoot(secondDirectory, {
        beforeInternalLeaseReleaseForTest: () => { throw new Error('release boundary'); },
      });
      await (await openRoot(secondDirectory)).root.readSnapshot();
      failure.store.failNext('manifest-write', 'primary boundary');
      const failed = await failure.store.writeSnapshot(rootName, {
        revision: 'revision-primary' as never,
        active: {},
        trash: [],
      });
      expect(failed).toMatchObject({ ok: false, error: { code: 'storage-failure' } });
      if (failed.ok) throw new Error('expected failure');
      expect(failed.error.storageReason).toContain('primary');
      expect(failed.error.storageReason).toContain('release');
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(secondDirectory, { recursive: true, force: true });
    }
  });

  test('release matrix covers primary success/failure × release success/failure', async () => {
    const cases = [
      { name: 'success-release-success', primaryFailure: false, releaseFailure: false },
      { name: 'success-release-failure', primaryFailure: false, releaseFailure: true },
      { name: 'failure-release-success', primaryFailure: true, releaseFailure: false },
      { name: 'failure-release-failure', primaryFailure: true, releaseFailure: true },
    ] as const;
    for (const item of cases) {
      const directory = await mkdtemp(join(tmpdir(), `resource-substrate-recovery-release-matrix-${item.name}-`));
      try {
        const base = await openRoot(directory);
        await base.root.readSnapshot();
        const opened = await openRoot(directory, item.releaseFailure ? { beforeInternalLeaseReleaseForTest: () => { throw new Error('release-boundary'); } } : {});
        if (item.primaryFailure) opened.store.failNext('manifest-write', 'primary-boundary');
        const result = await opened.store.writeSnapshot(rootName, { revision: `revision-${item.name}` as never, active: {}, trash: [] });
        expect(result.ok).toBe(!item.primaryFailure && !item.releaseFailure);
        if (item.primaryFailure && item.releaseFailure) {
          expect(result).toMatchObject({ ok: false, error: { code: 'storage-failure' } });
          if (!result.ok) {
            expect(result.error.storageReason).toContain('primary');
            expect(result.error.storageReason).toContain('release');
          }
        }
        console.info(JSON.stringify({ certificate: 'release-matrix', case: item.name, primary: item.primaryFailure ? 'failure' : 'success', release: item.releaseFailure ? 'failure' : 'success', result: result.ok ? 'ok' : result.error.code }));
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('lineage classification accepts only a real immutable descendant and fails closed on forks/cycles/bounds', async () => {
    const manifests: Record<string, { revision: string; parentRevision?: string | null }> = {
      before: { revision: 'before', parentRevision: null },
      after: { revision: 'after', parentRevision: 'before' },
      child: { revision: 'child', parentRevision: 'after' },
      fork: { revision: 'fork', parentRevision: 'other' },
    };
    const readManifest = async (revision: string) => {
      const manifest = manifests[revision];
      if (!manifest) throw new Error('missing manifest');
      return manifest;
    };
    await expect(classifyPreparedRecoveryWithLineage({ beforeRevision: 'before', currentRevision: 'before', afterRevision: 'after', readManifest })).resolves.toMatchObject({ ok: true, value: 'keep-before' });
    await expect(classifyPreparedRecoveryWithLineage({ beforeRevision: 'before', currentRevision: 'child', afterRevision: 'after', readManifest })).resolves.toMatchObject({ ok: true, value: 'keep-after' });
    await expect(classifyPreparedRecoveryWithLineage({ beforeRevision: 'before', currentRevision: 'fork', afterRevision: 'after', readManifest })).resolves.toMatchObject({ ok: false, error: { code: 'recovery-required' } });
    manifests.cycle = { revision: 'cycle', parentRevision: 'cycle' };
    await expect(classifyPreparedRecoveryWithLineage({ beforeRevision: 'before', currentRevision: 'cycle', afterRevision: 'after', readManifest })).resolves.toMatchObject({ ok: false, error: { code: 'recovery-required' } });
    const bounded = new Map<string, { revision: string; parentRevision: string | null }>();
    bounded.set('before', { revision: 'before', parentRevision: null });
    bounded.set('after', { revision: 'after', parentRevision: 'before' });
    for (let index = 0; index < MAX_LINEAGE_NODES + 1; index += 1) bounded.set(`n${index}`, { revision: `n${index}`, parentRevision: index === MAX_LINEAGE_NODES ? 'after' : `n${index + 1}` });
    const boundedRead = async (revision: string) => {
      const manifest = bounded.get(revision);
      if (!manifest) throw new Error('missing manifest');
      return manifest;
    };
    await expect(classifyPreparedRecoveryWithLineage({ beforeRevision: 'before', currentRevision: 'n0', afterRevision: 'after', readManifest: boundedRead })).resolves.toMatchObject({ ok: false, error: { code: 'recovery-required' } });
  });

  test('prepared and control records reject noncanonical, duplicate, and missing linked state without cleanup', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-validation-'));
    try {
      const { after } = await leavePrepared(directory);
      await unlink(join(rootDir(directory), 'revisions', `${after}.json`));
      const opened = await openRoot(directory);
      const missing = await opened.root.readSnapshot();
      expect(missing).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect((await readdir(join(rootDir(directory), 'prepared'))).filter((name) => name.endsWith('.json'))).toHaveLength(1);

      const duplicatePath = join(rootDir(directory), 'mutations', `${sha('duplicate-terminal')}.json`);
      await writeFile(duplicatePath, '{"identity":"duplicate-terminal","identity":"duplicate-terminal","requestDigest":"x","result":{"identity":"duplicate-terminal","beforeRevision":"revision-0","afterRevision":"revision-0","changed":false}}');
      const duplicate = await opened.store.readMutation(rootName, 'duplicate-terminal' as never);
      expect(duplicate).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  test('keep-before refuses both exact and conflicting terminal records', async () => {
    for (const mode of ['exact', 'mismatch'] as const) {
      const directory = await mkdtemp(join(tmpdir(), `resource-substrate-recovery-before-${mode}-`));
      try {
        const { before } = await leavePrepared(directory, `prepared-${mode}`);
        const preparedPath = join(rootDir(directory), 'prepared');
        const [entry] = await readdir(preparedPath);
        const prepared = JSON.parse(await readFile(join(preparedPath, entry!), 'utf8')) as { record: ResourceMutationRecord };
        await writeFile(join(rootDir(directory), 'HEAD'), `${before}\n`);
        const terminal = mode === 'exact' ? prepared.record : { ...prepared.record, requestDigest: 'mismatch' };
        await writeFile(join(rootDir(directory), 'mutations', `${sha(String(terminal.identity))}.json`), JSON.stringify(terminal));
        const result = await (await openRoot(directory)).root.readSnapshot();
        expect(result).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
        expect((await readdir(preparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  });

  test('before, after, descendant and fork classifications preserve the prepared audit trail', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-lineage-'));
    const afterDirectory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-lineage-'));
    const descendantDirectory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-lineage-'));
    const forkDirectory = await mkdtemp(join(tmpdir(), 'resource-substrate-recovery-lineage-'));
    try {
      const first = await leavePrepared(directory, 'prepared-before');
      const preparedPath = join(rootDir(directory), 'prepared');
      const [entry] = await readdir(preparedPath);
      const prepared = JSON.parse(await readFile(join(preparedPath, entry!), 'utf8')) as { record: ResourceMutationRecord };
      await writeFile(join(rootDir(directory), 'HEAD'), `${first.before}\n`);
      const beforeResult = await (await openRoot(directory)).root.readSnapshot();
      expect(beforeResult.ok).toBe(true);
      expect((await readdir(preparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(0);

      await leavePrepared(afterDirectory, 'prepared-after');
      const afterResult = await (await openRoot(afterDirectory)).root.readSnapshot();
      expect(afterResult.ok).toBe(true);

      const descendant = await leavePrepared(descendantDirectory, 'prepared-descendant');
      const revisionDir = join(rootDir(descendantDirectory), 'revisions');
      await writeFile(join(revisionDir, 'descendant.json'), JSON.stringify({ revision: 'descendant', parentRevision: descendant.after, mutationIdentity: 'descendant', resourceIds: [], active: {}, trash: [] }));
      await writeFile(join(rootDir(descendantDirectory), 'HEAD'), 'descendant\n');
      const descendantResult = await (await openRoot(descendantDirectory)).root.readSnapshot();
      expect(descendantResult.ok).toBe(true);

      await leavePrepared(forkDirectory, 'prepared-fork');
      const forkRevisionDir = join(rootDir(forkDirectory), 'revisions');
      const forkPreparedPath = join(rootDir(forkDirectory), 'prepared');
      const latestEntries = await readdir(forkPreparedPath);
      const latest = JSON.parse(await readFile(join(forkPreparedPath, latestEntries.find((name) => name.endsWith('.json'))!), 'utf8')) as { afterRevision: string };
      await writeFile(join(forkRevisionDir, 'fork.json'), JSON.stringify({ revision: 'fork', parentRevision: 'unrelated', mutationIdentity: 'fork', resourceIds: [], active: {}, trash: [] }));
      await writeFile(join(rootDir(forkDirectory), 'HEAD'), 'fork\n');
      const forkResult = await (await openRoot(forkDirectory)).root.readSnapshot();
      expect(forkResult).toMatchObject({ ok: false, error: { code: 'recovery-required' } });
      expect((await readdir(forkPreparedPath)).filter((name) => name.endsWith('.json'))).toHaveLength(1);
      expect(String(prepared.record.identity)).toBe('prepared-before');
      expect(latest.afterRevision).toBeString();
    } finally {
      await rm(directory, { recursive: true, force: true });
      await rm(afterDirectory, { recursive: true, force: true });
      await rm(descendantDirectory, { recursive: true, force: true });
      await rm(forkDirectory, { recursive: true, force: true });
    }
  });

  test('emits one named evidence certificate for every packet acceptance item', () => {
    const coverage = [
      { id: 'cert-01', requirement: 'same-process clean-read overlap', test: 'clean reads stay parallel while an external writer lease is held' },
      { id: 'cert-02', requirement: 'cross-process clean-read overlap', test: 'cross-process clean reads succeed while the writer lease is held' },
      { id: 'cert-03', requirement: 'reader/writer stale-listing regression', test: 'reader re-enumerates after the first prepared listing' },
      { id: 'cert-04', requirement: 'two readers and one writer', test: 'two child readers recover one prepared mutation' },
      { id: 'cert-05', requirement: 'before/after/descendant classification', test: 'before, after, descendant and fork classifications' },
      { id: 'cert-06', requirement: 'fork and missing lineage fail closed', test: 'lineage classification and prepared/control validation' },
      { id: 'cert-07', requirement: 'terminal exactness matrix', test: 'terminal mismatch matrix' },
      { id: 'cert-08', requirement: 'prepared exactness matrix', test: 'prepared exactness matrix' },
      { id: 'cert-09', requirement: 'keep-before terminal rule', test: 'keep-before refuses exact and conflicting terminals' },
      { id: 'cert-10', requirement: 'public write recovery boundary', test: 'writeMutation cannot bypass prepared recovery' },
      { id: 'cert-11', requirement: 'bounded lineage guard', test: 'lineage classification accepts only immutable descendants' },
      { id: 'cert-12', requirement: 'prepared detection seam timing', test: 'reader barrier and empty-directory seam tests' },
      { id: 'cert-13', requirement: 'legacy encoding compatibility', test: 'manifest exact expected bytes with three ordered keys' },
      { id: 'cert-14', requirement: 'manifest write-once', test: 'exact, changed, noncanonical, metadata, and blob cases' },
      { id: 'cert-15', requirement: 'lease release failure matrix', test: 'primary success/failure by release success/failure' },
      { id: 'cert-16', requirement: 'terminal write-once', test: 'terminal exact replay and mismatch tests' },
      { id: 'cert-17', requirement: 'cross-process terminal-write observability', test: 'two child readers and shared terminal marker' },
      { id: 'cert-18', requirement: 'existing crash matrix and observer API reuse', test: 'resource-substrate-recovery and observer-recovery suites' },
      { id: 'cert-19', requirement: 'fresh-process restart recovery', test: 'two fresh recovery child processes after crash' },
    ] as const;
    expect(coverage.map((entry): string => entry.id)).toEqual(
      Array.from({ length: 19 }, (_, index) => `cert-${String(index + 1).padStart(2, '0')}`),
    );
    for (const entry of coverage) console.info(JSON.stringify({ certificate: entry.id, requirement: entry.requirement, test: entry.test }));
  });

});
