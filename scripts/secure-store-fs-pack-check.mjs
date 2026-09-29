import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { buildSecureStoreFs } from './build-secure-store-fs.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');

function fail(message) {
  throw new Error(`secure-store-fs pack: ${message}`);
}

function currentTarget() {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || (process.arch !== 'arm64' && process.arch !== 'x64')) {
    fail('current host is outside the supported target matrix');
  }
  return `${process.platform}-${process.arch}`;
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', shell: false, ...options });
  if (result.error || result.status !== 0) fail(`command failed: ${command}`);
  return result;
}

function packPackage(destination) {
  const result = run(process.env.BUN_BIN ?? 'bun', ['pm', 'pack', '--destination', destination], { cwd: PACKAGE_ROOT });
  const packageFile = readdirSync(destination).find((entry) => entry.endsWith('.tgz'));
  if (!packageFile) fail(`bun pm pack produced no tarball: ${String(result.stdout ?? '')}`);
  return join(destination, packageFile);
}

function extractPackage(tarball, destination) {
  mkdirSync(destination, { recursive: true, mode: 0o700 });
  run('tar', ['-xzf', tarball, '-C', destination]);
  const packageDirectory = join(destination, 'package');
  if (!existsSync(join(packageDirectory, 'package.json'))) fail('packed package has no package.json');
  return packageDirectory;
}

function writeConsumerScript(path) {
  writeFileSync(path, `
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  createSecureStoreFsClient,
  resolveSecureStoreFsBroker,
} from '@forgeax/platform-io/secure-store-fs';

const packageRoot = process.env.FORGEAX_PACKED_PACKAGE_ROOT;
if (!packageRoot) throw new Error('packed package root is missing');
const target = process.env.FORGEAX_PACKED_TARGET;
const info = resolveSecureStoreFsBroker();
const realPackageRoot = await realpath(packageRoot);
const realHelperPath = await realpath(info.path);
if (!realHelperPath.startsWith(join(realPackageRoot, 'native')) && !realHelperPath.startsWith(join(realPackageRoot, 'dist', 'native'))) {
  throw new Error('packed consumer resolved a non-packed helper');
}
if (info.target !== target) throw new Error('packed consumer selected the wrong target');
const root = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-packed-'));
const client = createSecureStoreFsClient({ root, profile: 'model-exchange-v1' });
try {
  await client.ensureLayout();
  const blobName = \`${'a'.repeat(64)}.json\`;
  if (!await client.createIfAbsent('blobs', blobName, new TextEncoder().encode('packed\\n'))) throw new Error('packed create-if-absent failed');
  const bytes = await client.read('blobs', blobName);
  if (!bytes || new TextDecoder().decode(bytes) !== 'packed\\n') throw new Error('packed readback failed');
  const owner = new TextEncoder().encode('{"schemaVersion":1,"pid":1,"nonce":"packed-owner","acquiredAt":"2026-01-01T00:00:00.000Z","heartbeatAt":"2026-01-01T00:00:00.000Z"}');
  const acquired = await client.lockAcquire(owner);
  if (!acquired.acquired || acquired.dev === undefined || acquired.ino === undefined) throw new Error('packed lock acquire failed');
  const inspection = await client.lockInspect();
  if (!inspection || inspection.dev !== acquired.dev || inspection.ino !== acquired.ino) throw new Error('packed lock inspect failed');
  if (!await client.lockRelease(inspection, 'packed-owner', owner)) throw new Error('packed lock release failed');
} finally {
  await client.close();
  await rm(root, { recursive: true, force: true });
}
`, { mode: 0o600 });
}

export function runPackedCleanConsumer({ packageTarball, target = currentTarget() } = {}) {
  const temporary = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-pack-check-'));
  try {
    if (!packageTarball) {
      const currentBinary = join(PACKAGE_ROOT, 'dist', 'native', 'secure-store-fs', `secure-store-fs-${target}`);
      if (!existsSync(currentBinary)) buildSecureStoreFs({ target, outputDirectory: join(PACKAGE_ROOT, 'dist', 'native', 'secure-store-fs') });
    }
    const tarball = packageTarball ? resolve(packageTarball) : packPackage(temporary);
    const packedRoot = extractPackage(tarball, join(temporary, 'extract'));
    const consumerRoot = join(temporary, 'consumer');
    mkdirSync(join(consumerRoot, 'node_modules', '@forgeax'), { recursive: true, mode: 0o700 });
    symlinkSync(packedRoot, join(consumerRoot, 'node_modules', '@forgeax', 'platform-io'), 'dir');
    const script = join(consumerRoot, 'consumer.mjs');
    writeConsumerScript(script);
    const environment = {
      ...process.env,
      CC: '/definitely/missing/forgeax-compiler',
      CXX: '/definitely/missing/forgeax-cxx',
      FORGEAX_SECURE_STORE_FS_DISABLE_SOURCE_FALLBACK: '1',
      FORGEAX_PACKED_PACKAGE_ROOT: packedRoot,
      FORGEAX_PACKED_TARGET: target,
    };
    run(process.env.BUN_BIN ?? 'bun', ['run', script], { cwd: consumerRoot, env: environment, stdio: 'inherit' });
    return { target, tarball, packedRoot };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function main(args) {
  const packageTarball = args.includes('--package') ? args[args.indexOf('--package') + 1] : undefined;
  const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : currentTarget();
  const result = runPackedCleanConsumer({ packageTarball, target });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'secure-store-fs pack check failed'}\n`);
    process.exitCode = 1;
  }
}
