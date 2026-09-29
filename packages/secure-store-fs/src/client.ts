/**
 * Bounded client for the source-derived POSIX secure-store broker.
 *
 * The root is an exec-time authority argument only.  Once the broker sends
 * READY, this client emits only closed profile-derived parent codes,
 * validated basenames, bounded scalar fields, and hex bytes.  Error messages
 * intentionally contain no root, basename, payload, or native strerror.
 */

import { createHash } from 'node:crypto';
import {
  lstatSync,
  readFileSync,
} from 'node:fs';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import {
  SECURE_STORE_FS_LIMITS,
  SECURE_STORE_FS_PROTOCOL_VERSION,
  SECURE_STORE_FS_PROFILES,
  SECURE_STORE_FS_TEST_BARRIERS,
  type SecureStoreFsErrorCode,
  type SecureStoreFsParent,
  type SecureStoreFsProfile,
  type SecureStoreFsTestBarrier,
} from './protocol';

export {
  SECURE_STORE_FS_ARTIFACT_PROTOCOL_VERSION,
  SECURE_STORE_FS_LIMITS,
  SECURE_STORE_FS_OPERATIONS,
  SECURE_STORE_FS_PARENTS,
  SECURE_STORE_FS_PROFILES,
  SECURE_STORE_FS_PROTOCOL_VERSION,
  SECURE_STORE_FS_TEST_BARRIERS,
  type SecureStoreFsErrorCode,
  type SecureStoreFsOperation,
  type SecureStoreFsParent,
  type SecureStoreFsProfile,
  type SecureStoreFsTestBarrier,
} from './protocol';

const START_TIMEOUT_MS = 5_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 60_000;

const ERROR_MESSAGES: Record<SecureStoreFsErrorCode, string> = {
  secure_store_unsafe: 'secure store filesystem operation failed safely',
  secure_store_io: 'secure store filesystem operation failed',
  secure_store_protocol: 'secure store filesystem protocol is invalid',
  secure_store_unsupported: 'secure store filesystem operation is unsupported',
  secure_store_not_found: 'secure store entry was not found',
  secure_store_exists: 'secure store entry already exists',
  secure_store_value_limit: 'secure store value exceeds its limit',
  secure_store_root_missing: 'secure store root is missing',
  secure_store_helper_unavailable: 'secure store helper is unavailable',
  secure_store_request_timeout: 'secure store helper request timed out',
  secure_store_client_closed: 'secure store client is closed',
  secure_store_parent_unsupported: 'secure store parent is unsupported for this profile',
};

export class SecureStoreFsError extends Error {
  readonly code: SecureStoreFsErrorCode;

  constructor(code: SecureStoreFsErrorCode) {
    super(ERROR_MESSAGES[code]);
    this.name = 'SecureStoreFsError';
    this.code = code;
  }
}

export class SecureStoreFsRootMissingError extends SecureStoreFsError {
  constructor() {
    super('secure_store_root_missing');
    this.name = 'SecureStoreFsRootMissingError';
  }
}

export interface SecureStoreFsLockInspection {
  readonly dev: number;
  readonly ino: number;
  readonly owner: Buffer;
}

export interface SecureStoreFsLockAcquireResult {
  readonly acquired: boolean;
  readonly dev?: number;
  readonly ino?: number;
}

export interface SecureStoreFsBrokerInfo {
  readonly path: string;
  readonly sha256: string;
  readonly platform: NodeJS.Platform;
  readonly arch: string;
  readonly target: string;
}

export interface ResolveSecureStoreFsBrokerOptions {
  readonly helperPath?: string;
}

export interface SecureStoreFsClientOptions extends ResolveSecureStoreFsBrokerOptions {
  readonly root: string;
  readonly profile: SecureStoreFsProfile;
  readonly createRoot?: boolean;
  readonly requestTimeoutMs?: number;
}

function errorCode(error: unknown): SecureStoreFsErrorCode | undefined {
  if (!error || typeof error !== 'object') return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === 'string' && code in ERROR_MESSAGES ? code as SecureStoreFsErrorCode : undefined;
}

function fixedError(code: SecureStoreFsErrorCode): SecureStoreFsError {
  return new SecureStoreFsError(code);
}

function safeRootPath(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || Buffer.byteLength(value, 'utf8') > SECURE_STORE_FS_LIMITS.maxRootBytes
    || !isAbsolute(value)
    || value === '/'
    || value.includes('\u0000')
    || /[\u0001-\u001f\u007f-\u009f]/u.test(value)
  ) throw fixedError('secure_store_unsafe');
  const normalized = process.platform === 'darwin'
    ? value === '/tmp' || value.startsWith('/tmp/')
      ? `/private${value}`
      : value === '/var' || value.startsWith('/var/')
        ? `/private${value}`
        : value
    : value;
  const parts = normalized.split('/').slice(1);
  if (
    parts.length === 0
    || parts.some((part) =>
      part.length === 0
      || part === '.'
      || part === '..'
      || Buffer.byteLength(part, 'utf8') > SECURE_STORE_FS_LIMITS.maxNameBytes)
  ) throw fixedError('secure_store_unsafe');
  return normalized;
}

function safeName(value: string): string {
  if (
    typeof value !== 'string'
    || value.length === 0
    || value === '.'
    || value === '..'
    || Buffer.byteLength(value, 'utf8') > SECURE_STORE_FS_LIMITS.maxNameBytes
    || value.includes('/')
    || value.includes('\\')
    || value.includes('\u0000')
    || /[\u0001-\u001f\u007f-\u009f]/u.test(value)
  ) throw fixedError('secure_store_unsafe');
  return value;
}

function boundedTimeout(value: number | undefined, fallback: number): number {
  const selected = value ?? fallback;
  if (!Number.isFinite(selected) || selected < 1 || selected > MAX_TIMEOUT_MS) {
    throw fixedError('secure_store_value_limit');
  }
  return Math.floor(selected);
}

function targetTriple(): string {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw fixedError('secure_store_unsupported');
  }
  if (process.arch !== 'arm64' && process.arch !== 'x64') {
    throw fixedError('secure_store_unsupported');
  }
  return `${process.platform}-${process.arch}`;
}

function helperName(): string {
  return `secure-store-fs-${targetTriple()}`;
}

function executableFile(path: string): boolean {
  try {
    const stats = lstatSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

const resolvedHelpers = new Map<string, string>();

export function resolveSecureStoreFsBroker(options: ResolveSecureStoreFsBrokerOptions = {}): SecureStoreFsBrokerInfo {
  const target = targetTriple();
  const name = `secure-store-fs-${target}`;
  let helper = options.helperPath;
  if (helper !== undefined) {
    if (!isAbsolute(helper) || !executableFile(helper)) throw fixedError('secure_store_helper_unavailable');
  } else {
    helper = resolvedHelpers.get(target);
    if (!helper) {
      const moduleDirectory = dirname(fileURLToPath(import.meta.url));
      // Published dist/client.js and source-level workspace execution live
      // one directory below the independent package root. The final candidate
      // preserves the private @forgeax/platform-io compatibility pack, whose
      // source shim is nested two more levels below that pack's dist/native.
      // Every candidate is prebuilt; none invokes a compiler or source build.
      const packageRoot = resolve(moduleDirectory, '..');
      const packagedCandidates = [
        join(packageRoot, 'native', 'secure-store-fs', name),
        join(packageRoot, 'dist', 'native', 'secure-store-fs', name),
        join(packageRoot, '..', '..', 'dist', 'native', 'secure-store-fs', name),
      ];
      helper = packagedCandidates.find((candidate) => executableFile(candidate));
      if (!helper) throw fixedError('secure_store_helper_unavailable');
      resolvedHelpers.set(target, helper);
    }
  }
  if (!helper) throw fixedError('secure_store_helper_unavailable');
  let digest: string;
  try {
    digest = createHash('sha256').update(readFileSync(helper)).digest('hex');
  } catch {
    throw fixedError('secure_store_helper_unavailable');
  }
  return { path: helper, sha256: digest, platform: process.platform, arch: process.arch, target };
}

function encodeHex(value: Uint8Array, maxBytes: number): string {
  if (value.byteLength > maxBytes) throw fixedError('secure_store_value_limit');
  return value.byteLength === 0 ? '-' : Buffer.from(value).toString('hex');
}

function decodeHex(value: string, maxBytes: number): Buffer {
  if (value === '-') return Buffer.alloc(0);
  if (!/^(?:[a-f0-9]{2})*$/u.test(value) || value.length / 2 > maxBytes) throw fixedError('secure_store_protocol');
  return Buffer.from(value, 'hex');
}

function safeId(value: string): number {
  if (!/^\d{1,10}$/u.test(value)) throw fixedError('secure_store_protocol');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw fixedError('secure_store_protocol');
  return parsed;
}

function safeStatNumber(value: string): number {
  if (!/^\d{1,24}$/u.test(value)) throw fixedError('secure_store_protocol');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw fixedError('secure_store_protocol');
  return parsed;
}

function protocolLine(tokens: readonly string[]): string {
  const line = `${tokens.join(' ')}\n`;
  if (Buffer.byteLength(line, 'utf8') > SECURE_STORE_FS_LIMITS.maxFrameBytes) throw fixedError('secure_store_value_limit');
  return line;
}

function protocolError(code: string): SecureStoreFsError {
  switch (code) {
    case 'not_found': return fixedError('secure_store_not_found');
    case 'exists': return fixedError('secure_store_exists');
    case 'limit': return fixedError('secure_store_value_limit');
    case 'unsupported': return fixedError('secure_store_unsupported');
    case 'bad_request': return fixedError('secure_store_protocol');
    case 'unsafe': return fixedError('secure_store_unsafe');
    case 'io': return fixedError('secure_store_io');
    default: return fixedError('secure_store_protocol');
  }
}

function parseResponseLine(line: string, requestId: number): string[] {
  const fields = line.split(' ');
  if (fields.some((field) => field.length === 0) || fields[0] !== SECURE_STORE_FS_PROTOCOL_VERSION || fields.length < 3 || fields[1] === 'FATAL') {
    throw fixedError('secure_store_protocol');
  }
  const responseId = safeId(fields[2]!);
  if (responseId !== requestId) throw fixedError('secure_store_protocol');
  if (fields[1] === 'ROOT_MISSING') {
    if (fields.length !== 3) throw fixedError('secure_store_protocol');
    throw new SecureStoreFsRootMissingError();
  }
  if (fields[1] === 'ERR') {
    if (fields.length !== 4) throw fixedError('secure_store_protocol');
    throw protocolError(fields[3]!);
  }
  if (fields[1] !== 'OK') throw fixedError('secure_store_protocol');
  return fields.slice(3);
}

function parseReady(output: string, profile: SecureStoreFsProfile): 'ok' | 'missing' {
  const lines = output.split('\n').filter((line) => line.length > 0);
  const ready = lines.find((line) => line.startsWith(`${SECURE_STORE_FS_PROTOCOL_VERSION} READY `));
  if (!ready) throw fixedError('secure_store_protocol');
  const fields = ready.split(' ');
  if (fields.length === 3 && fields[2] === 'missing') return 'missing';
  if (fields.length !== 4 || fields[2] !== 'ok' || fields[3] !== profile) throw fixedError('secure_store_protocol');
  if (lines.some((line) => line.startsWith(`${SECURE_STORE_FS_PROTOCOL_VERSION} FATAL `))) throw fixedError('secure_store_helper_unavailable');
  return 'ok';
}

function parseSyncResponse(output: string, requestId: number, profile: SecureStoreFsProfile): string[] {
  const ready = parseReady(output, profile);
  if (ready === 'missing') throw new SecureStoreFsRootMissingError();
  const lines = output.split('\n').filter((line) => line.length > 0);
  for (const line of lines) {
    const fields = line.split(' ');
    if (fields[0] === SECURE_STORE_FS_PROTOCOL_VERSION && fields[2] === String(requestId)) {
      return parseResponseLine(line, requestId);
    }
  }
  throw fixedError('secure_store_protocol');
}

interface PendingRequest {
  readonly resolve: (value: string[]) => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

interface BarrierWaiter {
  readonly resolve: () => void;
  readonly reject: (error: unknown) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

function parentCode(profile: SecureStoreFsProfile, parent: SecureStoreFsParent): string {
  if (!SECURE_STORE_FS_PROFILES.includes(profile)) throw fixedError('secure_store_protocol');
  if (parent === 'reservations' && profile !== 'wire-capture-v1') throw fixedError('secure_store_parent_unsupported');
  if (parent === 'root') return 'R';
  if (parent === 'blobs') return 'B';
  if (parent === 'reservations') return 'S';
  throw fixedError('secure_store_protocol');
}

function nonceValue(value: string): string {
  if (!/^[A-Za-z0-9_-]{8,255}$/u.test(value)) throw fixedError('secure_store_protocol');
  return value;
}

export class SecureStoreFsClient {
  readonly root: string;
  readonly profile: SecureStoreFsProfile;
  readonly createRoot: boolean;
  readonly helperPath: string;

  private readonly requestTimeoutMs: number;
  private child: ChildProcess | undefined;
  private readyPromise: Promise<void> | undefined;
  private readyResolve: (() => void) | undefined;
  private readyReject: ((error: unknown) => void) | undefined;
  private readyState: 'pending' | 'ok' | 'missing' | 'failed' = 'pending';
  private stdoutBuffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly barrierWaiters = new Map<string, BarrierWaiter>();
  private closed = false;
  private closing = false;

  constructor(options: SecureStoreFsClientOptions) {
    if (!SECURE_STORE_FS_PROFILES.includes(options.profile)) throw fixedError('secure_store_protocol');
    this.root = safeRootPath(options.root);
    this.profile = options.profile;
    this.createRoot = options.createRoot ?? true;
    this.requestTimeoutMs = boundedTimeout(options.requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS);
    this.helperPath = resolveSecureStoreFsBroker(options).path;
  }

  get rootAvailable(): boolean {
    return this.readyState === 'ok';
  }

  private fail(error: unknown): void {
    const code = errorCode(error) ?? 'secure_store_protocol';
    const safe = error instanceof SecureStoreFsError ? error : fixedError(code);
    this.readyState = 'failed';
    this.readyReject?.(safe);
    this.readyReject = undefined;
    this.readyResolve = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(safe);
    }
    this.pending.clear();
    for (const waiter of this.barrierWaiters.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(safe);
    }
    this.barrierWaiters.clear();
    const child = this.child;
    if (child && child.exitCode === null && child.signalCode === null) {
      try { child.kill(); } catch { /* the process is already gone */ }
    }
  }

  private handleLine(line: string): void {
    const fields = line.split(' ');
    if (fields[0] === SECURE_STORE_FS_PROTOCOL_VERSION && fields[1] === 'BARRIER') {
      if (fields.length !== 3 || !SECURE_STORE_FS_TEST_BARRIERS.includes(fields[2] as SecureStoreFsTestBarrier)) {
        this.fail(fixedError('secure_store_protocol'));
        return;
      }
      const waiter = this.barrierWaiters.get(fields[2]!);
      if (!waiter) {
        this.fail(fixedError('secure_store_protocol'));
        return;
      }
      this.barrierWaiters.delete(fields[2]!);
      clearTimeout(waiter.timer);
      waiter.resolve();
      return;
    }
    if (this.readyState === 'pending') {
      if (line.startsWith(`${SECURE_STORE_FS_PROTOCOL_VERSION} READY `)) {
        const fieldsReady = line.split(' ');
        if (fieldsReady.length === 3 && fieldsReady[2] === 'missing') {
          this.readyState = 'missing';
          this.readyResolve?.();
          this.readyResolve = undefined;
          this.readyReject = undefined;
          return;
        }
        if (fieldsReady.length === 4 && fieldsReady[2] === 'ok' && fieldsReady[3] === this.profile) {
          this.readyState = 'ok';
          this.readyResolve?.();
          this.readyResolve = undefined;
          this.readyReject = undefined;
          return;
        }
      }
      this.fail(fixedError('secure_store_protocol'));
      return;
    }
    if (fields.length < 3 || fields[0] !== SECURE_STORE_FS_PROTOCOL_VERSION) {
      this.fail(fixedError('secure_store_protocol'));
      return;
    }
    let requestId: number;
    try {
      requestId = safeId(fields[2]!);
    } catch (error) {
      this.fail(error);
      return;
    }
    const pending = this.pending.get(requestId);
    if (!pending) {
      this.fail(fixedError('secure_store_protocol'));
      return;
    }
    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    try {
      pending.resolve(parseResponseLine(line, requestId));
    } catch (error) {
      pending.reject(error);
      const code = errorCode(error);
      if (code === 'secure_store_protocol' || code === 'secure_store_value_limit' || code === 'secure_store_helper_unavailable') this.fail(error);
    }
  }

  private consumeStdout(chunk: Buffer | string): void {
    this.stdoutBuffer += chunk.toString();
    if (Buffer.byteLength(this.stdoutBuffer, 'utf8') > SECURE_STORE_FS_LIMITS.maxFrameBytes) {
      this.fail(fixedError('secure_store_value_limit'));
      return;
    }
    while (true) {
      const newline = this.stdoutBuffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).replace(/\r$/u, '');
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      this.handleLine(line);
    }
  }

  private async start(): Promise<void> {
    if (this.closed) throw fixedError('secure_store_client_closed');
    if (this.readyState === 'failed') throw fixedError('secure_store_protocol');
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = new Promise<void>((resolveReady, rejectReady) => {
      this.readyResolve = resolveReady;
      this.readyReject = rejectReady;
      let child: ChildProcess;
      try {
        child = spawn(this.helperPath, [this.root, this.createRoot ? 'create' : 'existing', this.profile], {
          shell: false,
          stdio: ['pipe', 'pipe', 'ignore'],
        });
      } catch {
        rejectReady(fixedError('secure_store_helper_unavailable'));
        return;
      }
      this.child = child;
      child.stdout?.on('data', (chunk: Buffer | string) => this.consumeStdout(chunk));
      child.on('error', () => this.fail(fixedError('secure_store_helper_unavailable')));
      child.on('close', () => {
        if (this.closing) return;
        if (this.readyState === 'pending') this.fail(fixedError('secure_store_helper_unavailable'));
        else if (this.pending.size > 0) this.fail(fixedError('secure_store_protocol'));
        else if (!this.closed) this.fail(fixedError('secure_store_protocol'));
      });
    });
    const timer = setTimeout(() => this.fail(fixedError('secure_store_helper_unavailable')), START_TIMEOUT_MS);
    timer.unref?.();
    try {
      await this.readyPromise;
    } finally {
      clearTimeout(timer);
    }
  }

  private async request(operation: string, args: readonly string[] = []): Promise<string[]> {
    await this.start();
    if (this.readyState === 'missing' && operation !== 'CLOSE') throw new SecureStoreFsRootMissingError();
    if (this.readyState !== 'ok' && operation !== 'CLOSE') throw fixedError('secure_store_helper_unavailable');
    const requestId = this.nextRequestId++;
    const line = protocolLine([SECURE_STORE_FS_PROTOCOL_VERSION, String(requestId), operation, ...args]);
    return new Promise<string[]>((resolveResponse, rejectResponse) => {
      const child = this.child;
      if (!child?.stdin || child.stdin.destroyed) {
        rejectResponse(fixedError('secure_store_helper_unavailable'));
        return;
      }
      const timer = setTimeout(() => {
        if (this.pending.has(requestId)) this.fail(fixedError('secure_store_request_timeout'));
      }, this.requestTimeoutMs);
      timer.unref?.();
      this.pending.set(requestId, { resolve: resolveResponse, reject: rejectResponse, timer });
      try {
        child.stdin.write(line);
      } catch {
        this.pending.delete(requestId);
        clearTimeout(timer);
        rejectResponse(fixedError('secure_store_helper_unavailable'));
      }
    });
  }

  private requestSync(operation: string, args: readonly string[] = []): string[] {
    if (this.closed) throw fixedError('secure_store_client_closed');
    const requestId = 1;
    const request = protocolLine([SECURE_STORE_FS_PROTOCOL_VERSION, String(requestId), operation, ...args]);
    const close = protocolLine([SECURE_STORE_FS_PROTOCOL_VERSION, '2', 'CLOSE']);
    const result = spawnSync(this.helperPath, [this.root, this.createRoot ? 'create' : 'existing', this.profile], {
      input: request + close,
      encoding: 'utf8',
      shell: false,
      stdio: ['pipe', 'pipe', 'ignore'],
      maxBuffer: SECURE_STORE_FS_LIMITS.maxFrameBytes + 4_096,
      timeout: this.requestTimeoutMs,
    });
    if (result.error) {
      const code = (result.error as { code?: unknown }).code;
      throw code === 'ETIMEDOUT' ? fixedError('secure_store_request_timeout') : fixedError('secure_store_helper_unavailable');
    }
    if (result.status !== 0) {
      if (String(result.stdout ?? '').includes(`${SECURE_STORE_FS_PROTOCOL_VERSION} READY missing`)) throw new SecureStoreFsRootMissingError();
      throw fixedError('secure_store_helper_unavailable');
    }
    return parseSyncResponse(String(result.stdout ?? ''), requestId, this.profile);
  }

  private nameArg(name: string): string {
    return encodeHex(Buffer.from(safeName(name), 'utf8'), SECURE_STORE_FS_LIMITS.maxNameBytes);
  }

  private parentArg(parent: SecureStoreFsParent): string {
    return parentCode(this.profile, parent);
  }

  async ensureLayout(): Promise<void> { await this.request('ENSURE'); }
  ensureLayoutSync(): void { this.requestSync('ENSURE'); }

  async storagePresent(): Promise<boolean> {
    const response = await this.request('STORAGE');
    if (response.length !== 1 || (response[0] !== '0' && response[0] !== '1')) throw fixedError('secure_store_protocol');
    return response[0] === '1';
  }

  storagePresentSync(): boolean {
    const response = this.requestSync('STORAGE');
    if (response.length !== 1 || (response[0] !== '0' && response[0] !== '1')) throw fixedError('secure_store_protocol');
    return response[0] === '1';
  }

  async read(parent: SecureStoreFsParent, name: string): Promise<Buffer | undefined> {
    let response: string[];
    try {
      response = await this.request('READ', [this.parentArg(parent), this.nameArg(name)]);
    } catch (error) {
      if (error instanceof SecureStoreFsError && error.code === 'secure_store_not_found') return undefined;
      throw error;
    }
    if (response.length !== 2 || response[0] !== 'DATA') throw fixedError('secure_store_protocol');
    return decodeHex(response[1]!, SECURE_STORE_FS_LIMITS.maxFileBytes);
  }

  readSync(parent: SecureStoreFsParent, name: string): Buffer | undefined {
    let response: string[];
    try {
      response = this.requestSync('READ', [this.parentArg(parent), this.nameArg(name)]);
    } catch (error) {
      if (error instanceof SecureStoreFsError && error.code === 'secure_store_not_found') return undefined;
      throw error;
    }
    if (response.length !== 2 || response[0] !== 'DATA') throw fixedError('secure_store_protocol');
    return decodeHex(response[1]!, SECURE_STORE_FS_LIMITS.maxFileBytes);
  }

  async writeExclusive(parent: SecureStoreFsParent, name: string, content: Uint8Array): Promise<void> {
    await this.request('WRITE_EXCLUSIVE', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
  }

  writeExclusiveSync(parent: SecureStoreFsParent, name: string, content: Uint8Array): void {
    this.requestSync('WRITE_EXCLUSIVE', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
  }

  async append(parent: SecureStoreFsParent, name: string, content: Uint8Array): Promise<void> {
    await this.request('APPEND', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
  }

  appendSync(parent: SecureStoreFsParent, name: string, content: Uint8Array): void {
    this.requestSync('APPEND', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
  }

  async replace(parent: SecureStoreFsParent, name: string, content: Uint8Array): Promise<void> {
    await this.request('WRITE_ATOMIC', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
  }

  replaceSync(parent: SecureStoreFsParent, name: string, content: Uint8Array): void {
    this.requestSync('WRITE_ATOMIC', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
  }

  async createIfAbsent(parent: SecureStoreFsParent, name: string, content: Uint8Array): Promise<boolean> {
    try {
      await this.request('CREATE_IF_ABSENT', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
      return true;
    } catch (error) {
      if (error instanceof SecureStoreFsError && error.code === 'secure_store_exists') return false;
      throw error;
    }
  }

  createIfAbsentSync(parent: SecureStoreFsParent, name: string, content: Uint8Array): boolean {
    try {
      this.requestSync('CREATE_IF_ABSENT', [this.parentArg(parent), this.nameArg(name), encodeHex(content, SECURE_STORE_FS_LIMITS.maxContentBytes)]);
      return true;
    } catch (error) {
      if (error instanceof SecureStoreFsError && error.code === 'secure_store_exists') return false;
      throw error;
    }
  }

  async remove(parent: SecureStoreFsParent, name: string): Promise<boolean> {
    try {
      await this.request('REMOVE', [this.parentArg(parent), this.nameArg(name)]);
      return true;
    } catch (error) {
      if (error instanceof SecureStoreFsError && error.code === 'secure_store_not_found') return false;
      throw error;
    }
  }

  removeSync(parent: SecureStoreFsParent, name: string): boolean {
    try {
      this.requestSync('REMOVE', [this.parentArg(parent), this.nameArg(name)]);
      return true;
    } catch (error) {
      if (error instanceof SecureStoreFsError && error.code === 'secure_store_not_found') return false;
      throw error;
    }
  }

  async list(parent: SecureStoreFsParent): Promise<string[]> {
    return this.decodeList(await this.request('LIST', [this.parentArg(parent)]));
  }

  listSync(parent: SecureStoreFsParent): string[] {
    return this.decodeList(this.requestSync('LIST', [this.parentArg(parent)]));
  }

  private decodeList(response: readonly string[]): string[] {
    if (response.length < 2 || response[0] !== 'LIST' || !/^\d{1,4}$/u.test(response[1]!)) throw fixedError('secure_store_protocol');
    const count = Number(response[1]);
    if (count > SECURE_STORE_FS_LIMITS.maxListEntries || response.length !== count + 2) throw fixedError('secure_store_protocol');
    return response.slice(2).map((encoded) => safeName(decodeHex(encoded, SECURE_STORE_FS_LIMITS.maxNameBytes).toString('utf8')));
  }

  async syncDirectory(parent: SecureStoreFsParent): Promise<void> {
    await this.request('SYNC', [this.parentArg(parent)]);
  }

  syncDirectorySync(parent: SecureStoreFsParent): void {
    this.requestSync('SYNC', [this.parentArg(parent)]);
  }

  async lockInspect(): Promise<SecureStoreFsLockInspection | undefined> {
    return this.decodeLockInspection(await this.request('LOCK_INSPECT'));
  }

  lockInspectSync(): SecureStoreFsLockInspection | undefined {
    return this.decodeLockInspection(this.requestSync('LOCK_INSPECT'));
  }

  private decodeLockInspection(response: readonly string[]): SecureStoreFsLockInspection | undefined {
    if (response.length === 1 && response[0] === 'LOCK_NONE') return undefined;
    if (response.length !== 4 || response[0] !== 'LOCK') throw fixedError('secure_store_protocol');
    return {
      dev: safeStatNumber(response[1]!),
      ino: safeStatNumber(response[2]!),
      owner: decodeHex(response[3]!, SECURE_STORE_FS_LIMITS.maxOwnerBytes),
    };
  }

  async lockAcquire(owner: Uint8Array): Promise<SecureStoreFsLockAcquireResult> {
    const response = await this.request('LOCK_ACQUIRE', [encodeHex(owner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
    if (response.length === 1 && response[0] === 'BUSY') return { acquired: false };
    if (response.length !== 3 || response[0] !== 'ACQUIRED') throw fixedError('secure_store_protocol');
    return { acquired: true, dev: safeStatNumber(response[1]!), ino: safeStatNumber(response[2]!) };
  }

  lockAcquireSync(owner: Uint8Array): SecureStoreFsLockAcquireResult {
    const response = this.requestSync('LOCK_ACQUIRE', [encodeHex(owner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
    if (response.length === 1 && response[0] === 'BUSY') return { acquired: false };
    if (response.length !== 3 || response[0] !== 'ACQUIRED') throw fixedError('secure_store_protocol');
    return { acquired: true, dev: safeStatNumber(response[1]!), ino: safeStatNumber(response[2]!) };
  }

  async lockReclaim(inspection: SecureStoreFsLockInspection, nonce: string, owner: Uint8Array): Promise<boolean> {
    const response = await this.request('LOCK_RECLAIM', [nonceValue(nonce), String(inspection.dev), String(inspection.ino), encodeHex(owner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
    if (response.length !== 1 || (response[0] !== 'YES' && response[0] !== 'NO')) throw fixedError('secure_store_protocol');
    return response[0] === 'YES';
  }

  lockReclaimSync(inspection: SecureStoreFsLockInspection, nonce: string, owner: Uint8Array): boolean {
    const response = this.requestSync('LOCK_RECLAIM', [nonceValue(nonce), String(inspection.dev), String(inspection.ino), encodeHex(owner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
    if (response.length !== 1 || (response[0] !== 'YES' && response[0] !== 'NO')) throw fixedError('secure_store_protocol');
    return response[0] === 'YES';
  }

  async lockRelease(inspection: SecureStoreFsLockInspection, nonce: string, owner: Uint8Array): Promise<boolean> {
    const response = await this.request('LOCK_RELEASE', [nonceValue(nonce), String(inspection.dev), String(inspection.ino), encodeHex(owner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
    if (response.length !== 1 || (response[0] !== 'YES' && response[0] !== 'NO')) throw fixedError('secure_store_protocol');
    return response[0] === 'YES';
  }

  lockReleaseSync(inspection: SecureStoreFsLockInspection, nonce: string, owner: Uint8Array): boolean {
    const response = this.requestSync('LOCK_RELEASE', [nonceValue(nonce), String(inspection.dev), String(inspection.ino), encodeHex(owner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
    if (response.length !== 1 || (response[0] !== 'YES' && response[0] !== 'NO')) throw fixedError('secure_store_protocol');
    return response[0] === 'YES';
  }

  async lockHeartbeat(inspection: SecureStoreFsLockInspection, oldOwner: Uint8Array, newOwner: Uint8Array): Promise<void> {
    await this.request('LOCK_HEARTBEAT', [String(inspection.dev), String(inspection.ino), encodeHex(oldOwner, SECURE_STORE_FS_LIMITS.maxOwnerBytes), encodeHex(newOwner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
  }

  lockHeartbeatSync(inspection: SecureStoreFsLockInspection, oldOwner: Uint8Array, newOwner: Uint8Array): void {
    this.requestSync('LOCK_HEARTBEAT', [String(inspection.dev), String(inspection.ino), encodeHex(oldOwner, SECURE_STORE_FS_LIMITS.maxOwnerBytes), encodeHex(newOwner, SECURE_STORE_FS_LIMITS.maxOwnerBytes)]);
  }

  /** Arm a deterministic barrier in a test-barrier binary. */
  async armTestBarrier(barrier: SecureStoreFsTestBarrier): Promise<void> {
    if (!SECURE_STORE_FS_TEST_BARRIERS.includes(barrier)) throw fixedError('secure_store_protocol');
    await this.request('TEST_BARRIER_ARM', [barrier]);
  }

  /** Wait for the next armed barrier event without using a sleep race. */
  waitForTestBarrier(barrier: SecureStoreFsTestBarrier, timeoutMs = START_TIMEOUT_MS): Promise<void> {
    if (!SECURE_STORE_FS_TEST_BARRIERS.includes(barrier)) return Promise.reject(fixedError('secure_store_protocol'));
    if (this.barrierWaiters.has(barrier)) return Promise.reject(fixedError('secure_store_protocol'));
    const timeout = boundedTimeout(timeoutMs, START_TIMEOUT_MS);
    return new Promise<void>((resolveBarrier, rejectBarrier) => {
      const timer = setTimeout(() => {
        this.barrierWaiters.delete(barrier);
        rejectBarrier(fixedError('secure_store_request_timeout'));
      }, timeout);
      timer.unref?.();
      this.barrierWaiters.set(barrier, { resolve: resolveBarrier, reject: rejectBarrier, timer });
    });
  }

  /** Release a barrier paused inside the native broker. */
  releaseTestBarrier(barrier: SecureStoreFsTestBarrier): void {
    if (!SECURE_STORE_FS_TEST_BARRIERS.includes(barrier)) throw fixedError('secure_store_protocol');
    const child = this.child;
    if (!child?.stdin || child.stdin.destroyed) throw fixedError('secure_store_helper_unavailable');
    child.stdin.write(protocolLine([SECURE_STORE_FS_PROTOCOL_VERSION, 'RELEASE', barrier]));
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.closing = true;
    const child = this.child;
    if (!child) return;
    const finish = () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(fixedError('secure_store_client_closed'));
      }
      this.pending.clear();
    };
    if (child.exitCode !== null || child.signalCode !== null) {
      finish();
      return;
    }
    const closeRequestId = this.nextRequestId++;
    const closeTimerForRequest = setTimeout(() => {
      if (this.pending.has(closeRequestId)) this.fail(fixedError('secure_store_request_timeout'));
    }, this.requestTimeoutMs);
    closeTimerForRequest.unref?.();
    this.pending.set(closeRequestId, {
      resolve: () => undefined,
      reject: () => undefined,
      timer: closeTimerForRequest,
    });
    try {
      if (child.stdin && !child.stdin.destroyed) child.stdin.write(protocolLine([SECURE_STORE_FS_PROTOCOL_VERSION, String(closeRequestId), 'CLOSE']));
    } catch {
      /* The child is already on its close path. */
      this.pending.delete(closeRequestId);
      clearTimeout(closeTimerForRequest);
    }
    await new Promise<void>((resolveClose) => {
      let settled = false;
      let closeTimer: ReturnType<typeof setTimeout> | undefined;
      const done = () => {
        if (settled) return;
        settled = true;
        if (closeTimer) clearTimeout(closeTimer);
        finish();
        resolveClose();
      };
      child.once('close', done);
      closeTimer = setTimeout(() => {
        if (child.exitCode === null && child.signalCode === null) {
          try { child.kill('SIGKILL'); } catch { /* the process is already gone */ }
        }
        done();
      }, this.requestTimeoutMs);
      closeTimer.unref?.();
    });
  }
}

export function createSecureStoreFsClient(options: SecureStoreFsClientOptions): SecureStoreFsClient {
  return new SecureStoreFsClient(options);
}

export function assertSecureStoreFsSupported(options: ResolveSecureStoreFsBrokerOptions = {}): void {
  resolveSecureStoreFsBroker(options);
}
