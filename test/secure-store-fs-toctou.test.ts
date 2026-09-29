import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSecureStoreFsClient,
  SecureStoreFsError,
  type SecureStoreFsClient,
  type SecureStoreFsLockInspection,
  type SecureStoreFsTestBarrier,
} from '../src/secure-store-fs';

const packageRoot = join(import.meta.dir, '..');
const buildScript = join(packageRoot, 'scripts', 'build-secure-store-fs.mjs');

function target(): string {
  if (!['darwin', 'linux'].includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`unsupported secure-store barrier host: ${process.platform}-${process.arch}`);
  }
  return `${process.platform}-${process.arch}`;
}

function buildBarrierNative(): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-barrier-build-'));
  const output = execFileSync(process.execPath, [
    buildScript,
    '--mode', 'test',
    '--target', target(),
    '--output', directory,
  ], { cwd: packageRoot, encoding: 'utf8' }).trim();
  const parsed = JSON.parse(output) as { output?: unknown };
  if (typeof parsed.output !== 'string') throw new Error('secure-store barrier build returned no output');
  return parsed.output;
}

function snapshot(path: string): { bytes: Buffer; mode: number; mtimeMs: number; dev: string; ino: string; type: string } {
  const stats = lstatSync(path);
  return {
    bytes: stats.isFile() ? readFileSync(path) : Buffer.alloc(0),
    mode: stats.mode & 0o777,
    mtimeMs: stats.mtimeMs,
    dev: String(stats.dev),
    ino: String(stats.ino),
    type: stats.isSymbolicLink() ? 'symlink' : stats.isDirectory() ? 'directory' : 'file',
  };
}

async function withClient(helper: string, profile: 'model-exchange-v1' | 'wire-capture-v1' = 'model-exchange-v1'): Promise<{ root: string; client: SecureStoreFsClient }> {
  const root = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-toctou-'));
  const client = createSecureStoreFsClient({ root, profile, helperPath: helper });
  await client.ensureLayout();
  return { root, client };
}

async function runPaused<T>(
  client: SecureStoreFsClient,
  barrier: SecureStoreFsTestBarrier,
  operation: () => Promise<T>,
  mutate: () => void | Promise<void>,
): Promise<{ value?: T; error?: unknown }> {
  await client.armTestBarrier(barrier);
  const paused = client.waitForTestBarrier(barrier);
  const result = operation().then((value) => ({ value }), (error: unknown) => ({ error }));
  await paused;
  try {
    await mutate();
  } finally {
    client.releaseTestBarrier(barrier);
  }
  return result;
}

function expectUnsafe(result: { error?: unknown }): void {
  expect(result.error).toBeInstanceOf(SecureStoreFsError);
  expect((result.error as SecureStoreFsError).code).toBe('secure_store_unsafe');
}

function owner(value: string): Buffer {
  return Buffer.from(`{"schemaVersion":1,"pid":999999,"nonce":"${value}","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}`);
}

interface RawHelper {
  readonly child: ChildProcessWithoutNullStreams;
  readonly next: (timeoutMs?: number) => Promise<string>;
}

function rawHelper(helper: string, root: string, mode: 'create' | 'existing'): RawHelper {
  const child = spawn(helper, [root, mode, 'model-exchange-v1'], { stdio: ['pipe', 'pipe', 'pipe'] });
  let buffer = '';
  const waiters: Array<{ resolve: (line: string) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }> = [];
  child.stdout.on('data', (chunk: Buffer | string) => {
    buffer += chunk.toString();
    while (true) {
      const newline = buffer.indexOf('\n');
      if (newline < 0 || waiters.length === 0) break;
      const line = buffer.slice(0, newline).replace(/\r$/u, '');
      buffer = buffer.slice(newline + 1);
      const waiter = waiters.shift()!;
      clearTimeout(waiter.timer);
      waiter.resolve(line);
    }
  });
  return {
    child,
    next(timeoutMs = 5_000): Promise<string> {
      const newline = buffer.indexOf('\n');
      if (newline >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        return Promise.resolve(line);
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('raw secure-store lock test timeout')), timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
  };
}

function sendRaw(raw: RawHelper, line: string): void {
  raw.child.stdin.write(`${line}\n`);
}

async function killRaw(raw: RawHelper): Promise<void> {
  if (raw.child.exitCode === null && raw.child.signalCode === null) raw.child.kill('SIGKILL');
  await new Promise<void>((resolve) => {
    if (raw.child.exitCode !== null || raw.child.signalCode !== null) resolve();
    else raw.child.once('close', () => resolve());
  });
}

function replaceLock(root: string, replacementOwner: Buffer): { oldPath: string; replacementPath: string } {
  const lockPath = join(root, '.writer-lock');
  const oldPath = join(root, '.writer-lock-old');
  renameSync(lockPath, oldPath);
  mkdirSync(lockPath, 0o700);
  const ownerPath = join(lockPath, 'owner.json');
  writeFileSync(ownerPath, replacementOwner, { mode: 0o600 });
  chmodSync(ownerPath, 0o600);
  return { oldPath, replacementPath: lockPath };
}

describe('secure-store-fs deterministic authority barriers', () => {
  test('acquire publishes a complete lock atomically and a fresh helper recovers after the publisher is killed', async () => {
    const helper = buildBarrierNative();
    const root = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-lock-acquire-crash-'));
    const crashOwner = owner('acquire-crash');
    const raw = rawHelper(helper, root, 'create');
    try {
      expect(await raw.next()).toBe('SSF1 READY ok model-exchange-v1');
      sendRaw(raw, 'SSF1 1 ENSURE');
      expect(await raw.next()).toBe('SSF1 OK 1');
      sendRaw(raw, 'SSF1 2 TEST_BARRIER_ARM lock-acquire-published');
      expect(await raw.next()).toBe('SSF1 OK 2');
      sendRaw(raw, `SSF1 3 LOCK_ACQUIRE ${crashOwner.toString('hex')}`);
      expect(await raw.next()).toBe('SSF1 BARRIER lock-acquire-published');
      expect(readFileSync(join(root, '.writer-lock', 'owner.json')).toString('hex')).toBe(crashOwner.toString('hex'));
      await killRaw(raw);

      const fresh = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
      try {
        const inspection = await fresh.lockInspect();
        expect(inspection?.owner).toEqual(crashOwner);
        if (!inspection) throw new Error('published crash lock was not inspectable');
        expect(await fresh.lockReclaim(inspection, 'acquire-crash', crashOwner)).toBe(true);
        const nextOwner = owner('acquire-next');
        const acquired = await fresh.lockAcquire(nextOwner);
        expect(acquired.acquired).toBe(true);
        const nextInspection = await fresh.lockInspect();
        if (!nextInspection) throw new Error('fresh lock was not inspectable');
        expect(await fresh.lockRelease(nextInspection, 'acquire-next', nextOwner)).toBe(true);
      } finally {
        await fresh.close();
      }

      const competing = rawHelper(helper, root, 'existing');
      try {
        expect(await competing.next()).toBe('SSF1 READY ok model-exchange-v1');
        sendRaw(competing, 'SSF1 1 TEST_BARRIER_ARM lock-acquire');
        expect(await competing.next()).toBe('SSF1 OK 1');
        sendRaw(competing, `SSF1 2 LOCK_ACQUIRE ${owner('candidate-lock').toString('hex')}`);
        expect(await competing.next()).toBe('SSF1 BARRIER lock-acquire');
        const replacementOwner = owner('acquire-replacement');
        const replacementPath = join(root, '.writer-lock');
        mkdirSync(replacementPath, 0o700);
        writeFileSync(join(replacementPath, 'owner.json'), replacementOwner, { mode: 0o600 });
        chmodSync(join(replacementPath, 'owner.json'), 0o600);
        const replacementBefore = snapshot(replacementPath);
        sendRaw(competing, 'SSF1 RELEASE lock-acquire');
        expect(await competing.next()).toBe('SSF1 OK 2 BUSY');
        expect(snapshot(replacementPath)).toEqual(replacementBefore);
        expect(readFileSync(join(replacementPath, 'owner.json')).toString('hex')).toBe(replacementOwner.toString('hex'));

        const replacementClient = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
        try {
          const replacementInspection = await replacementClient.lockInspect();
          if (!replacementInspection) throw new Error('acquire replacement lock was not inspectable');
          expect(await replacementClient.lockReclaim(replacementInspection, 'acquire-replacement', replacementOwner)).toBe(true);
          const recoveredOwner = owner('acquire-recovered');
          expect((await replacementClient.lockAcquire(recoveredOwner)).acquired).toBe(true);
          const recoveredInspection = await replacementClient.lockInspect();
          if (!recoveredInspection) throw new Error('recovered acquire lock was not inspectable');
          expect(await replacementClient.lockRelease(recoveredInspection, 'acquire-recovered', recoveredOwner)).toBe(true);
        } finally {
          await replacementClient.close();
        }
      } finally {
        await killRaw(competing);
      }
    } finally {
      await killRaw(raw);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('release unpublishes the complete lock atomically and a killed releaser never mutates a replacement inode', async () => {
    const helper = buildBarrierNative();
    const root = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-lock-release-crash-'));
    const releasedOwner = owner('release-crash');
    const setup = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper });
    let inspection: SecureStoreFsLockInspection | undefined;
    try {
      await setup.ensureLayout();
      expect((await setup.lockAcquire(releasedOwner)).acquired).toBe(true);
      inspection = await setup.lockInspect();
      if (!inspection) throw new Error('release crash lock was not inspectable');
    } finally {
      await setup.close();
    }

    const raw = rawHelper(helper, root, 'existing');
    try {
      expect(await raw.next()).toBe('SSF1 READY ok model-exchange-v1');
      sendRaw(raw, 'SSF1 1 TEST_BARRIER_ARM lock-release-unpublished');
      expect(await raw.next()).toBe('SSF1 OK 1');
      sendRaw(raw, `SSF1 2 LOCK_RELEASE release-crash ${inspection.dev} ${inspection.ino} ${releasedOwner.toString('hex')}`);
      expect(await raw.next()).toBe('SSF1 BARRIER lock-release-unpublished');
      expect(() => lstatSync(join(root, '.writer-lock'))).toThrow();

      const replacementOwner = owner('replacement-lock');
      const replacementPath = join(root, '.writer-lock');
      mkdirSync(replacementPath, 0o700);
      writeFileSync(join(replacementPath, 'owner.json'), replacementOwner, { mode: 0o600 });
      chmodSync(join(replacementPath, 'owner.json'), 0o600);
      const replacementBefore = snapshot(replacementPath);
      await killRaw(raw);

      const fresh = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
      try {
        const replacementInspection = await fresh.lockInspect();
        expect(replacementInspection?.owner).toEqual(replacementOwner);
        expect(snapshot(replacementPath)).toEqual(replacementBefore);
        expect((await fresh.lockAcquire(owner('blocked-owner'))).acquired).toBe(false);
        if (!replacementInspection) throw new Error('replacement lock was not inspectable');
        expect(await fresh.lockReclaim(replacementInspection, 'replacement-lock', replacementOwner)).toBe(true);
        const nextOwner = owner('release-next');
        expect((await fresh.lockAcquire(nextOwner)).acquired).toBe(true);
        const nextInspection = await fresh.lockInspect();
        if (!nextInspection) throw new Error('post-release lock was not inspectable');
        expect(await fresh.lockRelease(nextInspection, 'release-next', nextOwner)).toBe(true);
      } finally {
        await fresh.close();
      }
    } finally {
      await killRaw(raw);
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test('root replacement and ancestor replacement fail closed before any mutation', async () => {
    const helper = buildBarrierNative();
    const outside = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-outside-root-'));
    const parent = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-root-parent-'));
    const root = join(parent, 'root');
    mkdirSync(root, 0o700);
    const sentinel = join(outside, 'sentinel');
    writeFileSync(sentinel, Buffer.from('outside-root'), { mode: 0o600 });
    const rootClient = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
    try {
      await rootClient.ensureLayout();
      const before = snapshot(sentinel);
      const rootOld = join(parent, 'root-old');
      const rootResult = await runPaused(rootClient, 'root-before-operation', () => rootClient.syncDirectory('root'), () => {
        renameSync(root, rootOld);
        symlinkSync(outside, root);
      });
      expectUnsafe(rootResult);
      expect(snapshot(sentinel)).toEqual(before);
      unlinkSync(root);
      renameSync(rootOld, root);
    } finally {
      await rootClient.close();
      await rm(outside, { recursive: true, force: true });
      await rm(parent, { recursive: true, force: true });
    }

    const ancestorOutside = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-ancestor-outside-'));
    const ancestorSentinel = join(ancestorOutside, 'sentinel');
    writeFileSync(ancestorSentinel, Buffer.from('outside-ancestor'), { mode: 0o600 });
    const ancestorSentinelBefore = snapshot(ancestorSentinel);
    const ancestorParent = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-ancestor-parent-'));
    const ancestor = join(ancestorParent, 'ancestor');
    const nestedRoot = join(ancestor, 'root');
    mkdirSync(nestedRoot, { recursive: true, mode: 0o700 });
    const ancestorClient = createSecureStoreFsClient({ root: nestedRoot, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
    try {
      await ancestorClient.ensureLayout();
      const ancestorOld = join(ancestorParent, 'ancestor-old');
      const ancestorResult = await runPaused(ancestorClient, 'root-before-operation', () => ancestorClient.syncDirectory('root'), () => {
        renameSync(ancestor, ancestorOld);
        mkdirSync(ancestor, 0o700);
        symlinkSync(ancestorOutside, nestedRoot);
      });
      expectUnsafe(ancestorResult);
      expect(snapshot(ancestorSentinel)).toEqual(ancestorSentinelBefore);
      unlinkSync(nestedRoot);
      renameSync(ancestorOld, ancestor);
    } finally {
      await ancestorClient.close();
      await rm(ancestorParent, { recursive: true, force: true });
      await rm(ancestorOutside, { recursive: true, force: true });
    }
  });

  test('open read, append, and create barriers never follow a replaced target', async () => {
    const helper = buildBarrierNative();
    const fixture = await withClient(helper, 'wire-capture-v1');
    const outside = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-open-outside-'));
    const sentinel = join(outside, 'sentinel');
    writeFileSync(sentinel, Buffer.from('do-not-touch'), { mode: 0o600 });
    const sentinelBefore = snapshot(sentinel);
    try {
      const blobName = `${'a'.repeat(64)}.json`;
      const victim = join(fixture.root, 'blobs', blobName);
      expect(await fixture.client.createIfAbsent('blobs', blobName, Buffer.from('inside'))).toBe(true);
      const oldVictim = `${victim}.old`;
      const readResult = await runPaused(fixture.client, 'open-read', () => fixture.client.read('blobs', blobName), () => {
        renameSync(victim, oldVictim);
        symlinkSync(sentinel, victim);
      });
      expectUnsafe(readResult);
      expect(snapshot(sentinel)).toEqual(sentinelBefore);
      unlinkSync(victim);
      renameSync(oldVictim, victim);

      await fixture.client.append('root', 'index.jsonl', Buffer.from('inside\n'));
      const indexPath = join(fixture.root, 'index.jsonl');
      const oldIndex = `${indexPath}.old`;
      const appendResult = await runPaused(fixture.client, 'open-append', () => fixture.client.append('root', 'index.jsonl', Buffer.from('append\n')), () => {
        renameSync(indexPath, oldIndex);
        symlinkSync(sentinel, indexPath);
      });
      expectUnsafe(appendResult);
      expect(snapshot(sentinel)).toEqual(sentinelBefore);
      unlinkSync(indexPath);
      renameSync(oldIndex, indexPath);

      const reservationName = `${'b'.repeat(48)}.reserve`;
      const createTarget = join(fixture.root, '.reservations', reservationName);
      const createResult = await runPaused(fixture.client, 'open-create', () => fixture.client.writeExclusive('reservations', reservationName, Buffer.from('new')), () => {
        symlinkSync(sentinel, createTarget);
      });
      expect(createResult.error).toBeInstanceOf(SecureStoreFsError);
      expect((createResult.error as SecureStoreFsError).code).toBe('secure_store_exists');
      expect(snapshot(sentinel)).toEqual(sentinelBefore);
      unlinkSync(createTarget);
    } finally {
      await fixture.client.close();
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('atomic replace, atomic link-create, and unlink preserve the outside sentinel', async () => {
    const helper = buildBarrierNative();
    const fixture = await withClient(helper);
    const outside = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-rename-outside-'));
    const sentinel = join(outside, 'sentinel');
    writeFileSync(sentinel, Buffer.from('immutable-outside'), { mode: 0o600 });
    const sentinelBefore = snapshot(sentinel);
    try {
      const replaceName = `${'c'.repeat(64)}.json`;
      expect(await fixture.client.createIfAbsent('blobs', replaceName, Buffer.from('old'))).toBe(true);
      const replacePath = join(fixture.root, 'blobs', replaceName);
      const oldReplace = `${replacePath}.old`;
      const replaceResult = await runPaused(fixture.client, 'atomic-replace', () => fixture.client.replace('blobs', replaceName, Buffer.from('new')), () => {
        renameSync(replacePath, oldReplace);
        symlinkSync(sentinel, replacePath);
      });
      expectUnsafe(replaceResult);
      expect(snapshot(sentinel)).toEqual(sentinelBefore);
      expect(readdirSync(join(fixture.root, 'blobs')).filter((name) => name.includes('.secure-store-'))).toHaveLength(0);
      unlinkSync(replacePath);
      renameSync(oldReplace, replacePath);

      const createName = `${'d'.repeat(64)}.json`;
      const createPath = join(fixture.root, 'blobs', createName);
      const createResult = await runPaused(fixture.client, 'atomic-create', () => fixture.client.createIfAbsent('blobs', createName, Buffer.from('new')), () => {
        symlinkSync(sentinel, createPath);
      });
      expect(createResult.value).toBe(false);
      expect(snapshot(sentinel)).toEqual(sentinelBefore);
      expect(readdirSync(join(fixture.root, 'blobs')).filter((name) => name.includes('.secure-store-'))).toHaveLength(0);
      unlinkSync(createPath);

      const removeName = `${'e'.repeat(64)}.json`;
      expect(await fixture.client.createIfAbsent('blobs', removeName, Buffer.from('inside'))).toBe(true);
      const removePath = join(fixture.root, 'blobs', removeName);
      const oldRemove = `${removePath}.old`;
      const removeResult = await runPaused(fixture.client, 'unlink', () => fixture.client.remove('blobs', removeName), () => {
        renameSync(removePath, oldRemove);
        symlinkSync(sentinel, removePath);
      });
      expectUnsafe(removeResult);
      expect(snapshot(sentinel)).toEqual(sentinelBefore);
      unlinkSync(removePath);
      renameSync(oldRemove, removePath);
    } finally {
      await fixture.client.close();
      await rm(fixture.root, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    }
  });

  test('post-publication barriers reject replacement regular inodes', async () => {
    const helper = buildBarrierNative();
    const fixture = await withClient(helper);
    try {
      const replaceName = `${'f'.repeat(64)}.json`;
      const replacePath = join(fixture.root, 'blobs', replaceName);
      expect(await fixture.client.createIfAbsent('blobs', replaceName, Buffer.from('old'))).toBe(true);
      const publishedReplace = `${replacePath}.published`;
      const replaceResult = await runPaused(fixture.client, 'atomic-replace-published', () => fixture.client.replace('blobs', replaceName, Buffer.from('new')), () => {
        renameSync(replacePath, publishedReplace);
        writeFileSync(replacePath, Buffer.from('replacement'), { mode: 0o600 });
        chmodSync(replacePath, 0o600);
      });
      expectUnsafe(replaceResult);
      expect(readFileSync(replacePath)).toEqual(Buffer.from('replacement'));
      expect(readFileSync(publishedReplace)).toEqual(Buffer.from('new'));

      const createName = `${'0'.repeat(64)}.json`;
      const createPath = join(fixture.root, 'blobs', createName);
      const publishedCreate = `${createPath}.published`;
      const createResult = await runPaused(fixture.client, 'atomic-create-published', () => fixture.client.createIfAbsent('blobs', createName, Buffer.from('created')), () => {
        renameSync(createPath, publishedCreate);
        writeFileSync(createPath, Buffer.from('replacement'), { mode: 0o600 });
        chmodSync(createPath, 0o600);
      });
      expectUnsafe(createResult);
      expect(readFileSync(createPath)).toEqual(Buffer.from('replacement'));
      expect(readFileSync(publishedCreate)).toEqual(Buffer.from('created'));
    } finally {
      await fixture.client.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  });

  test('final lock removal is serialized across valid removers and a fresh acquirer', async () => {
    const helper = buildBarrierNative();
    const fixture = await withClient(helper);
    const secondRemover = createSecureStoreFsClient({ root: fixture.root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
    const acquirer = createSecureStoreFsClient({ root: fixture.root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
    try {
      const oldOwner = owner('serialized-old');
      expect((await fixture.client.lockAcquire(oldOwner)).acquired).toBe(true);
      const oldInspection = await fixture.client.lockInspect();
      if (!oldInspection) throw new Error('serialized lock inspection missing');
      await Promise.all([secondRemover.lockInspect(), acquirer.lockInspect()]);

      await fixture.client.armTestBarrier('lock-remove-before-unpublish');
      const paused = fixture.client.waitForTestBarrier('lock-remove-before-unpublish');
      const firstRelease = fixture.client.lockRelease(oldInspection, 'serialized-old', oldOwner);
      await paused;
      await Promise.all([
        secondRemover.armTestBarrier('writer-sequence-contended'),
        acquirer.armTestBarrier('writer-sequence-contended'),
      ]);
      const secondContended = secondRemover.waitForTestBarrier('writer-sequence-contended');
      const acquirerContended = acquirer.waitForTestBarrier('writer-sequence-contended');
      const secondRelease = secondRemover.lockRelease(oldInspection, 'serialized-old', oldOwner);
      const newOwner = owner('serialized-new');
      const acquire = acquirer.lockAcquire(newOwner);
      await Promise.all([secondContended, acquirerContended]);
      expect(readFileSync(join(fixture.root, '.writer-lock', 'owner.json')).toString('hex')).toBe(oldOwner.toString('hex'));
      secondRemover.releaseTestBarrier('writer-sequence-contended');
      acquirer.releaseTestBarrier('writer-sequence-contended');
      fixture.client.releaseTestBarrier('lock-remove-before-unpublish');

      expect(await firstRelease).toBe(true);
      expect(await secondRelease).toBe(false);
      const acquired = await acquire;
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired || acquired.dev === undefined || acquired.ino === undefined) throw new Error('serialized fresh acquisition missing identity');
      const newInspection = await acquirer.lockInspect();
      if (!newInspection) throw new Error('serialized replacement lock inspection missing');
      expect(newInspection.dev).toBe(acquired.dev);
      expect(newInspection.ino).toBe(acquired.ino);
      expect(newInspection.owner.toString('hex')).toBe(newOwner.toString('hex'));
      expect(await acquirer.lockRelease(newInspection, 'serialized-new', newOwner)).toBe(true);
    } finally {
      await Promise.all([fixture.client.close(), secondRemover.close(), acquirer.close()]);
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test('final pre-unpublish revalidation never moves a replacement lock inode', async () => {
    const helper = buildBarrierNative();
    const fixture = await withClient(helper);
    try {
      const oldOwner = owner('final-edge-old');
      expect((await fixture.client.lockAcquire(oldOwner)).acquired).toBe(true);
      const inspection = await fixture.client.lockInspect();
      if (!inspection) throw new Error('final-edge lock inspection missing');
      const replacementOwner = owner('final-edge-replacement');
      const result = await runPaused(
        fixture.client,
        'lock-remove-before-unpublish',
        () => fixture.client.lockRelease(inspection, 'final-edge-old', oldOwner),
        () => {
          replaceLock(fixture.root, replacementOwner);
        },
      );
      expect(result.value).toBe(false);
      const replacementPath = join(fixture.root, '.writer-lock');
      const replacementBefore = snapshot(replacementPath);
      expect(readFileSync(join(replacementPath, 'owner.json')).toString('hex')).toBe(replacementOwner.toString('hex'));
      const replacementInspection = await fixture.client.lockInspect();
      if (!replacementInspection) throw new Error('final-edge replacement inspection missing');
      expect(snapshot(replacementPath)).toEqual(replacementBefore);
      expect(await fixture.client.lockReclaim(replacementInspection, 'final-edge-replacement', replacementOwner)).toBe(true);
      expect(snapshot(join(fixture.root, '.writer-lock-old')).type).toBe('directory');
      expect(() => lstatSync(replacementPath)).toThrow();
      rmSync(join(fixture.root, '.writer-lock-old'), { recursive: true, force: true });
      expect(replacementBefore.type).toBe('directory');
    } finally {
      await fixture.client.close();
      await rm(fixture.root, { recursive: true, force: true });
    }
  }, 20_000);

  test('stale-lock reclaim, heartbeat, and release revalidate the lock inode and owner', async () => {
    const helper = buildBarrierNative();
    const fixture = await withClient(helper);
    try {
      const staleOwner = owner('stale-owner');
      const acquired = await fixture.client.lockAcquire(staleOwner);
      expect(acquired.acquired).toBe(true);
      if (!acquired.acquired || acquired.dev === undefined || acquired.ino === undefined) throw new Error('lock was not acquired');
      const inspection = await fixture.client.lockInspect();
      if (!inspection) throw new Error('lock inspection missing');
      const replacementOwner = owner('replacement-owner');
      const reclaimResult = await runPaused(fixture.client, 'lock-reclaim', () => fixture.client.lockReclaim(inspection, 'stale-owner', staleOwner), () => {
        replaceLock(fixture.root, replacementOwner);
      });
      expect(reclaimResult.value).toBe(false);
      expect(readFileSync(join(fixture.root, '.writer-lock', 'owner.json')).toString('hex')).toBe(replacementOwner.toString('hex'));
      const replacementLock = join(fixture.root, '.writer-lock');
      rmSync(replacementLock, { recursive: true, force: true });
      rmSync(join(fixture.root, '.writer-lock-old'), { recursive: true, force: true });
    } finally {
      await fixture.client.close();
      await rm(fixture.root, { recursive: true, force: true });
    }

    const heartbeatFixture = await withClient(helper);
    try {
      const oldOwner = owner('heartbeat-owner');
      const acquired = await heartbeatFixture.client.lockAcquire(oldOwner);
      expect(acquired.acquired).toBe(true);
      const inspection = await heartbeatFixture.client.lockInspect();
      if (!inspection) throw new Error('heartbeat lock inspection missing');
      const replacementOwner = owner('heartbeat-replacement');
      const heartbeatResult = await runPaused(heartbeatFixture.client, 'lock-heartbeat', () => heartbeatFixture.client.lockHeartbeat(inspection, oldOwner, owner('heartbeat-new')), () => {
        replaceLock(heartbeatFixture.root, replacementOwner);
      });
      expectUnsafe(heartbeatResult);
      expect(readFileSync(join(heartbeatFixture.root, '.writer-lock', 'owner.json')).toString('hex')).toBe(replacementOwner.toString('hex'));
      rmSync(join(heartbeatFixture.root, '.writer-lock'), { recursive: true, force: true });
      rmSync(join(heartbeatFixture.root, '.writer-lock-old'), { recursive: true, force: true });
    } finally {
      await heartbeatFixture.client.close();
      await rm(heartbeatFixture.root, { recursive: true, force: true });
    }

    const releaseFixture = await withClient(helper);
    try {
      const oldOwner = owner('release-owner');
      const acquired = await releaseFixture.client.lockAcquire(oldOwner);
      expect(acquired.acquired).toBe(true);
      const inspection = await releaseFixture.client.lockInspect();
      if (!inspection) throw new Error('release lock inspection missing');
      const replacementOwner = owner('release-replacement');
      const releaseResult = await runPaused(releaseFixture.client, 'lock-release', () => releaseFixture.client.lockRelease(inspection, 'release-owner', oldOwner), () => {
        replaceLock(releaseFixture.root, replacementOwner);
      });
      expect(releaseResult.value).toBe(false);
      expect(readFileSync(join(releaseFixture.root, '.writer-lock', 'owner.json')).toString('hex')).toBe(replacementOwner.toString('hex'));
      rmSync(join(releaseFixture.root, '.writer-lock'), { recursive: true, force: true });
      rmSync(join(releaseFixture.root, '.writer-lock-old'), { recursive: true, force: true });
    } finally {
      await releaseFixture.client.close();
      await rm(releaseFixture.root, { recursive: true, force: true });
    }
  });
});
