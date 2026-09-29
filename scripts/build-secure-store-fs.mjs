import {
  chmodSync,
  existsSync,
  mkdirSync,
  statSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeArtifactMetadata, SECURE_STORE_FS_TARGETS } from './secure-store-fs-artifact.mjs';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE = resolve(PACKAGE_ROOT, 'native', 'secure-store-fs', 'main.c');
const HEADER = resolve(PACKAGE_ROOT, 'native', 'secure-store-fs', 'protocol.h');

function fail(message) {
  throw new Error(`secure-store-fs build: ${message}`);
}

function hostTarget() {
  if ((process.platform !== 'darwin' && process.platform !== 'linux') || (process.arch !== 'arm64' && process.arch !== 'x64')) {
    fail('the current host is outside the supported native target matrix');
  }
  return `${process.platform}-${process.arch}`;
}

function compiler() {
  const configured = process.env.CC;
  if (configured && configured.trim() === configured && !/[\u0000\s]/u.test(configured)) return configured;
  return process.platform === 'darwin' ? 'clang' : 'cc';
}

function readOption(args, name, fallback) {
  const index = args.indexOf(name);
  return index >= 0 && index + 1 < args.length ? args[index + 1] : fallback;
}

export function buildSecureStoreFs({ mode = 'release', target = hostTarget(), outputDirectory = resolve(PACKAGE_ROOT, 'dist', 'native', 'secure-store-fs'), sourceHead = process.env.FORGEAX_SOURCE_HEAD ?? 'local-source-unpinned' } = {}) {
  if (mode !== 'release' && mode !== 'test') fail('mode must be release or test');
  const host = hostTarget();
  if (!SECURE_STORE_FS_TARGETS.includes(target)) fail(`target ${target} is outside the closed target matrix`);
  if (target !== host) fail(`refusing to cross-compile ${target} on ${host}`);
  if (!existsSync(SOURCE) || !existsSync(HEADER)) fail('native source or protocol header is missing');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const suffix = mode === 'test' ? `-test-${target}` : `-${target}`;
  const output = resolve(outputDirectory, `secure-store-fs${suffix}`);
  const args = [
    '-std=c11',
    mode === 'test' ? '-O0' : '-O2',
    ...(mode === 'test' ? ['-g', '-DFORGEAX_SECURE_STORE_TEST_BARRIERS=1'] : []),
    '-Wall',
    '-Wextra',
    '-Wpedantic',
    '-Werror',
    SOURCE,
    '-o',
    output,
  ];
  const result = spawnSync(compiler(), args, {
    cwd: PACKAGE_ROOT,
    encoding: 'utf8',
    shell: false,
    stdio: 'inherit',
    timeout: 120_000,
  });
  if (result.error || result.status !== 0) fail(`compiler exited unsuccessfully for ${target}`);
  chmodSync(output, 0o700);
  const stats = statSync(output);
  if (!stats.isFile() || (stats.mode & 0o111) === 0) fail('compiler did not produce an executable');
  if (mode === 'release') {
    writeArtifactMetadata({ binaryPath: output, target, sourceHead });
  }
  return { output, target, mode, bytes: stats.size };
}

function main(args) {
  const mode = readOption(args, '--mode', 'release');
  const target = readOption(args, '--target', hostTarget());
  const outputDirectory = resolve(readOption(args, '--output', resolve(PACKAGE_ROOT, 'dist', 'native', 'secure-store-fs')));
  const sourceHead = readOption(args, '--source-head', process.env.FORGEAX_SOURCE_HEAD ?? 'local-source-unpinned');
  const result = buildSecureStoreFs({ mode, target, outputDirectory, sourceHead });
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'secure-store-fs build failed'}\n`);
    process.exitCode = 1;
  }
}
