import { describe, expect, test } from 'bun:test';
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  chmodSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSecureStoreFsClient,
  SecureStoreFsError,
  SecureStoreFsRootMissingError,
  type SecureStoreFsClient,
  type SecureStoreFsErrorCode,
  type SecureStoreFsProfile,
} from '../src/secure-store-fs';

const packageRoot = join(import.meta.dir, '..');
const buildScript = join(packageRoot, 'scripts', 'build-secure-store-fs.mjs');
const supportedPlatforms = ['darwin', 'linux'];

function target(): string {
  if (!supportedPlatforms.includes(process.platform) || !['arm64', 'x64'].includes(process.arch)) {
    throw new Error(`unsupported secure-store test host: ${process.platform}-${process.arch}`);
  }
  return `${process.platform}-${process.arch}`;
}

function buildNative(mode: 'release' | 'test'): string {
  const directory = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-protocol-build-'));
  const output = execFileSync(process.execPath, [
    buildScript,
    '--mode', mode,
    '--target', target(),
    '--output', directory,
    '--source-head', 'test-source-head',
  ], { cwd: packageRoot, encoding: 'utf8' }).trim();
  const parsed = JSON.parse(output) as { output?: unknown };
  if (typeof parsed.output !== 'string') throw new Error('secure-store test build returned no output');
  return parsed.output;
}

async function closeClients(clients: readonly SecureStoreFsClient[]): Promise<void> {
  await Promise.all(clients.map((client) => client.close()));
}

function expectErrorCode(action: () => unknown, code: SecureStoreFsErrorCode): void {
  try {
    action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SecureStoreFsError);
    expect((error as SecureStoreFsError).code).toBe(code);
  }
}

async function expectAsyncErrorCode(action: () => Promise<unknown>, code: SecureStoreFsErrorCode): Promise<void> {
  try {
    await action();
    throw new Error(`expected ${code}`);
  } catch (error) {
    expect(error).toBeInstanceOf(SecureStoreFsError);
    expect((error as SecureStoreFsError).code).toBe(code);
  }
}

interface RawLines {
  readonly child: ChildProcessWithoutNullStreams;
  readonly next: (timeoutMs?: number) => Promise<string>;
}

function rawLines(child: ChildProcessWithoutNullStreams): RawLines {
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
      if (buffer.includes('\n')) {
        const newline = buffer.indexOf('\n');
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        return Promise.resolve(line);
      }
      return new Promise<string>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('raw secure-store protocol timeout')), timeoutMs);
        waiters.push({ resolve, reject, timer });
      });
    },
  };
}

function send(child: ChildProcessWithoutNullStreams, line: string): void {
  child.stdin.write(`${line}\n`);
}

async function closeRaw(raw: RawLines, id: number): Promise<void> {
  if (raw.child.exitCode === null) {
    send(raw.child, `SSF1 ${id} CLOSE`);
    await Promise.race([
      raw.next(),
      new Promise<void>((resolve) => raw.child.once('close', () => resolve())),
    ]).catch(() => undefined);
  }
  await new Promise<void>((resolve) => {
    if (raw.child.exitCode !== null) resolve();
    else raw.child.once('close', () => resolve());
  });
}

describe('secure-store-fs protocol and ordinary API', () => {
  test('runs on the supported native host instead of silently skipping', () => {
    expect(supportedPlatforms).toContain(process.platform);
    expect(['arm64', 'x64']).toContain(process.arch);
  });

  test('exposes both closed profiles and rejects an unknown profile before spawn', async () => {
    const helper = buildNative('release');
    const root = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-profile-'));
    try {
      expect(() => createSecureStoreFsClient({
        root,
        profile: 'unknown-profile' as SecureStoreFsProfile,
        helperPath: helper,
      })).toThrow();
      const child = spawn(helper, [root, 'create', 'unknown-profile'], { stdio: ['pipe', 'pipe', 'pipe'] });
      const raw = rawLines(child);
      expect(await raw.next()).toBe('SSF1 FATAL bad_startup');
      await closeRaw(raw, 1).catch(() => undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('round-trips the closed model and wire layouts and rejects undeclared capabilities', async () => {
    const helper = buildNative('release');
    const modelRoot = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-model-'));
    const wireRoot = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-wire-'));
    const model = createSecureStoreFsClient({ root: modelRoot, profile: 'model-exchange-v1', helperPath: helper });
    const wire = createSecureStoreFsClient({ root: wireRoot, profile: 'wire-capture-v1', helperPath: helper });
    try {
      await model.ensureLayout();
      await wire.ensureLayout();
      expect(await model.storagePresent()).toBe(true);
      expect(await wire.storagePresent()).toBe(true);
      const blobName = `${'a'.repeat(64)}.json`;
      const reservationName = `${'b'.repeat(48)}.reserve`;
      expect(await model.createIfAbsent('blobs', blobName, Uint8Array.from([1, 2]))).toBe(true);
      expect(await model.createIfAbsent('blobs', blobName, Uint8Array.from([9]))).toBe(false);
      expect(await model.read('blobs', blobName)).toEqual(Buffer.from([1, 2]));
      await model.replace('blobs', blobName, Uint8Array.from([4]));
      expect(await model.read('blobs', blobName)).toEqual(Buffer.from([4]));
      expect(await model.list('blobs')).toContain(blobName);
      await model.append('root', 'manifest.jsonl', Buffer.from('{"ok":true}\n'));
      expect(await model.read('root', 'manifest.jsonl')).toEqual(Buffer.from('{"ok":true}\n'));
      await wire.writeExclusive('reservations', reservationName, Uint8Array.from([7]));
      expect(await wire.read('reservations', reservationName)).toEqual(Buffer.from([7]));
      await model.syncDirectory('root');
      await expectAsyncErrorCode(() => model.read('reservations', 'not-allowed'), 'secure_store_parent_unsupported');
      await expectAsyncErrorCode(() => model.read('blobs', '../outside'), 'secure_store_unsafe');
      await expectAsyncErrorCode(() => model.read('blobs', 'arbitrary.json'), 'secure_store_protocol');
      await expectAsyncErrorCode(() => model.append('blobs', blobName, Uint8Array.from([5])), 'secure_store_protocol');
    } finally {
      await closeClients([model, wire]);
      await rm(modelRoot, { recursive: true, force: true });
      await rm(wireRoot, { recursive: true, force: true });
    }
  });

  test('rejects malformed commands and every test barrier in the release binary', async () => {
    const helper = buildNative('release');
    const root = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-release-protocol-'));
    const child = spawn(helper, [root, 'create', 'model-exchange-v1'], { stdio: ['pipe', 'pipe', 'pipe'] });
    const raw = rawLines(child);
    try {
      expect(await raw.next()).toBe('SSF1 READY ok model-exchange-v1');
      send(child, 'SSF1 1 TEST_BARRIER_ARM open-read');
      expect(await raw.next()).toBe('SSF1 ERR 1 unsupported');
      send(child, 'SSF1 2 UNKNOWN_COMMAND');
      expect(await raw.next()).toBe('SSF1 ERR 2 bad_request');
      send(child, 'SSF1 3 ENSURE');
      expect(await raw.next()).toBe('SSF1 OK 3');
      send(child, 'SSF1 4 READ B 00 trailing');
      expect(await raw.next()).toBe('SSF1 ERR 4 bad_request');
      send(child, 'SSF1 5 MKDIR R 2e7772697465722d6c6f636b');
      expect(await raw.next()).toBe('SSF1 ERR 5 bad_request');
      send(child, 'SSF1 6 RMDIR R 2e7772697465722d6c6f636b');
      expect(await raw.next()).toBe('SSF1 ERR 6 bad_request');
      send(child, 'SSF1 7 RENAME_DIR R 66726f6d R 746f');
      expect(await raw.next()).toBe('SSF1 ERR 7 bad_request');
      await closeRaw(raw, 8);
    } finally {
      if (child.exitCode === null) child.kill('SIGKILL');
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('serializes concurrent quota create-if-absent and writer lock ownership', async () => {
    const helper = buildNative('release');
    const root = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-concurrent-'));
    const setup = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper });
    const clients = Array.from({ length: 8 }, () => createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper }));
    try {
      await setup.ensureLayout();
      const created = await Promise.all(clients.map((client, index) => client.createIfAbsent('root', 'quota-state.json', Uint8Array.from([index]))));
      expect(created.filter(Boolean)).toHaveLength(1);
      const acquired = await Promise.all(clients.map((client, index) => client.lockAcquire(Buffer.from(`owner-${index}`))));
      expect(acquired.filter((entry) => entry.acquired)).toHaveLength(1);
      const winnerIndex = acquired.findIndex((entry) => entry.acquired);
      expect(winnerIndex).toBeGreaterThanOrEqual(0);
      const winner = clients[winnerIndex]!;
      const inspection = await winner.lockInspect();
      expect(inspection).not.toBeUndefined();
      if (!inspection) throw new Error('lock inspection unexpectedly missing');
      const winnerNonce = `owner-${winnerIndex}-nonce`;
      expect(await winner.lockRelease(inspection, winnerNonce, Buffer.from(`owner-${winnerIndex}`))).toBe(true);
      const after = await clients[0]!.lockAcquire(Buffer.from('owner-after'));
      expect(after.acquired).toBe(true);
      if (after.acquired) {
        const afterInspection = await clients[0]!.lockInspect();
        if (!afterInspection) throw new Error('second lock inspection unexpectedly missing');
        expect(await clients[0]!.lockRelease(afterInspection, 'owner-after', Buffer.from('owner-after'))).toBe(true);
      }
    } finally {
      await closeClients([setup, ...clients]);
      await rm(root, { recursive: true, force: true });
    }
  });

  test('maps an existing-root miss without exposing the absolute root', async () => {
    const helper = buildNative('release');
    const parent = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-missing-'));
    const root = join(parent, 'missing-root');
    const client = createSecureStoreFsClient({ root, profile: 'model-exchange-v1', helperPath: helper, createRoot: false });
    try {
      expect(client.rootAvailable).toBe(false);
      await expectAsyncErrorCode(() => client.ensureLayout(), 'secure_store_root_missing');
      expect(() => client.root).not.toThrow();
      expect(new SecureStoreFsRootMissingError().message).not.toContain(root);
    } finally {
      await client.close();
      await rm(parent, { recursive: true, force: true });
    }
  });
});
