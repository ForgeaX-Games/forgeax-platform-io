import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const HEADER_PATH = resolve(SCRIPT_DIR, '..', 'native', 'secure-store-fs', 'protocol.h');
const HEADER = readFileSync(HEADER_PATH, 'utf8');
const PROTOCOL_VERSION = HEADER.match(/#define\s+FORGEAX_SECURE_STORE_FS_PROTOCOL_VERSION\s+"([^"]+)"/u)?.[1];
if (!PROTOCOL_VERSION) throw new Error('secure-store-fs protocol header is invalid');

export const SECURE_STORE_FS_TARGETS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
];

const METADATA_KEYS = ['schemaVersion', 'protocolVersion', 'sourceHead', 'target', 'bytes', 'sha256'];
const MANIFEST_KEYS = ['schemaVersion', 'protocolVersion', 'sourceHead', 'targets'];

function fail(message) {
  throw new Error(`secure-store-fs artifact: ${message}`);
}

function exactKeys(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} is not an object`);
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((entry, index) => entry !== wanted[index])) {
    fail(`${label} has an unexpected field set`);
  }
}

function validSourceHead(value) {
  return typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u0020\u007f]/u.test(value);
}

function sha256File(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function isExecutable(path) {
  try {
    const stats = statSync(path);
    return stats.isFile() && (stats.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function binaryTargetMatches(path, target) {
  const bytes = readFileSync(path);
  if (target.startsWith('darwin-')) {
    if (bytes.length < 8) return false;
    const magicLe = bytes.readUInt32LE(0);
    const magicBe = bytes.readUInt32BE(0);
    let cpu;
    if (magicLe === 0xfeedfacf) cpu = bytes.readUInt32LE(4);
    else if (magicBe === 0xfeedfacf) cpu = bytes.readUInt32BE(4);
    else return false;
    return target === 'darwin-arm64' ? cpu === 0x0100000c : cpu === 0x01000007;
  }
  if (bytes.length < 20 || bytes[0] !== 0x7f || bytes[1] !== 0x45 || bytes[2] !== 0x4c || bytes[3] !== 0x46) return false;
  if (bytes[4] !== 2 || bytes[5] !== 1) return false;
  const machine = bytes.readUInt16LE(18);
  return target === 'linux-arm64' ? machine === 183 : machine === 62;
}

function releaseBinaryLooksClean(path) {
  const bytes = readFileSync(path);
  return !bytes.includes(Buffer.from('forgeax-secure-store-fs:test-barriers', 'utf8')) &&
    !bytes.includes(Buffer.from('FORGEAX_SECURE_STORE_TEST_BARRIERS', 'utf8'));
}

export function createArtifactMetadata({ binaryPath, target, sourceHead }) {
  if (!SECURE_STORE_FS_TARGETS.includes(target)) fail(`unexpected target ${target}`);
  if (!validSourceHead(sourceHead)) fail('sourceHead is not closed');
  if (!isExecutable(binaryPath)) fail(`binary is not executable for ${target}`);
  if (!binaryTargetMatches(binaryPath, target)) fail(`binary target mismatch for ${target}`);
  if (!releaseBinaryLooksClean(binaryPath)) fail(`release binary contains test-barrier marker for ${target}`);
  const stats = statSync(binaryPath);
  return {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    sourceHead,
    target,
    bytes: stats.size,
    sha256: sha256File(binaryPath),
  };
}

export function writeArtifactMetadata({ binaryPath, target, sourceHead, metadataPath = `${binaryPath}.json` }) {
  const metadata = createArtifactMetadata({ binaryPath, target, sourceHead });
  writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o600 });
  chmodSync(metadataPath, 0o600);
  return metadata;
}

function parseJson(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    fail(`${label} is not valid JSON`);
  }
  return value;
}

export function validateArtifactMetadata({ binaryPath, metadataPath, expectedTarget, expectedSourceHead }) {
  const metadata = parseJson(metadataPath, `${expectedTarget} metadata`);
  exactKeys(metadata, METADATA_KEYS, `${expectedTarget} metadata`);
  if (metadata.schemaVersion !== 1 || metadata.protocolVersion !== PROTOCOL_VERSION) fail(`${expectedTarget} metadata version mismatch`);
  if (metadata.target !== expectedTarget || !SECURE_STORE_FS_TARGETS.includes(metadata.target)) fail(`${expectedTarget} metadata target mismatch`);
  if (expectedSourceHead !== undefined && metadata.sourceHead !== expectedSourceHead) fail(`${expectedTarget} metadata source head mismatch`);
  if (!validSourceHead(metadata.sourceHead) || !Number.isSafeInteger(metadata.bytes) || metadata.bytes < 1 ||
      !/^[a-f0-9]{64}$/u.test(metadata.sha256)) fail(`${expectedTarget} metadata values are invalid`);
  if (!isExecutable(binaryPath) || !binaryTargetMatches(binaryPath, expectedTarget)) fail(`${expectedTarget} binary is not a native executable for its target`);
  if (!releaseBinaryLooksClean(binaryPath)) fail(`${expectedTarget} release binary contains test-barrier marker`);
  const stats = statSync(binaryPath);
  if (metadata.bytes !== stats.size || metadata.sha256 !== sha256File(binaryPath)) fail(`${expectedTarget} metadata hash or size mismatch`);
  return metadata;
}

function candidateFiles(inputDirectory, target) {
  const matches = [];
  const wanted = `secure-store-fs-${target}`;
  const walk = (directory, depth) => {
    if (depth > 4 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name === wanted) matches.push(path);
    }
  };
  walk(inputDirectory, 0);
  return matches;
}

function unexpectedNativeBinaries(inputDirectory) {
  const expected = new Set(SECURE_STORE_FS_TARGETS.map((target) => `secure-store-fs-${target}`));
  const unexpected = [];
  const walk = (directory, depth) => {
    if (depth > 4 || !existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.startsWith('secure-store-fs-') && !entry.name.endsWith('.json') && !expected.has(entry.name)) {
        unexpected.push(entry.name);
      }
    }
  };
  walk(inputDirectory, 0);
  return unexpected;
}

export function aggregateArtifacts({ inputDirectory, outputDirectory, sourceHead }) {
  if (!validSourceHead(sourceHead)) fail('aggregate sourceHead is not closed');
  const unexpected = unexpectedNativeBinaries(inputDirectory);
  if (unexpected.length > 0) fail('aggregate input contains an unexpected target artifact');
  mkdirSync(outputDirectory, { recursive: true, mode: 0o700 });
  const metadata = [];
  for (const target of SECURE_STORE_FS_TARGETS) {
    const matches = candidateFiles(inputDirectory, target);
    if (matches.length !== 1) fail(`${target} is missing or duplicated`);
    const sourceBinary = matches[0];
    const sourceMetadata = `${sourceBinary}.json`;
    if (!existsSync(sourceMetadata)) fail(`${target} metadata is missing`);
    // GitHub's upload/download artifact transport does not preserve executable
    // mode. The candidate is already closed to one regular file name here;
    // normalize its mode before validating native target, size, and digest.
    chmodSync(sourceBinary, 0o700);
    const verified = validateArtifactMetadata({
      binaryPath: sourceBinary,
      metadataPath: sourceMetadata,
      expectedTarget: target,
      expectedSourceHead: sourceHead,
    });
    const destinationBinary = join(outputDirectory, `secure-store-fs-${target}`);
    const destinationMetadata = `${destinationBinary}.json`;
    copyFileSync(sourceBinary, destinationBinary);
    chmodSync(destinationBinary, 0o700);
    writeFileSync(destinationMetadata, `${JSON.stringify(verified, null, 2)}\n`, { mode: 0o600 });
    metadata.push(verified);
  }
  const manifest = {
    schemaVersion: 1,
    protocolVersion: PROTOCOL_VERSION,
    sourceHead,
    targets: metadata,
  };
  writeFileSync(join(outputDirectory, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

export function validateAggregateManifest({ manifestPath, binaryDirectory = dirname(manifestPath), expectedSourceHead }) {
  const manifest = parseJson(manifestPath, 'aggregate manifest');
  exactKeys(manifest, MANIFEST_KEYS, 'aggregate manifest');
  if (manifest.schemaVersion !== 1 || manifest.protocolVersion !== PROTOCOL_VERSION || !validSourceHead(manifest.sourceHead)) fail('aggregate manifest header is invalid');
  if (expectedSourceHead !== undefined && manifest.sourceHead !== expectedSourceHead) fail('aggregate manifest source head mismatch');
  if (!Array.isArray(manifest.targets) || manifest.targets.length !== SECURE_STORE_FS_TARGETS.length) fail('aggregate manifest target count is invalid');
  const seen = new Set();
  for (const target of SECURE_STORE_FS_TARGETS) {
    const rows = manifest.targets.filter((row) => row && row.target === target);
    if (rows.length !== 1 || seen.has(target)) fail(`aggregate manifest target ${target} is missing or duplicated`);
    seen.add(target);
    const binaryPath = join(binaryDirectory, `secure-store-fs-${target}`);
    const metadataPath = `${binaryPath}.json`;
    if (!existsSync(binaryPath) || !existsSync(metadataPath)) fail(`aggregate binary ${target} is missing`);
    const checked = validateArtifactMetadata({
      binaryPath,
      metadataPath,
      expectedTarget: target,
      expectedSourceHead: manifest.sourceHead,
    });
    exactKeys(rows[0], METADATA_KEYS, `${target} manifest row`);
    const row = rows[0];
    for (const key of METADATA_KEYS) {
      if (checked[key] !== row[key]) fail(`aggregate manifest row ${target} differs from its binary`);
    }
  }
  return manifest;
}

function option(args, name, required = true) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) {
    if (required) fail(`missing ${name}`);
    return undefined;
  }
  return args[index + 1];
}

function main(args) {
  const command = args[0];
  if (command === 'write') {
    const binaryPath = resolve(option(args, '--binary'));
    const target = option(args, '--target');
    const sourceHead = option(args, '--source-head');
    const metadata = writeArtifactMetadata({ binaryPath, target, sourceHead });
    process.stdout.write(`${JSON.stringify(metadata)}\n`);
    return;
  }
  if (command === 'aggregate') {
    const manifest = aggregateArtifacts({
      inputDirectory: resolve(option(args, '--input-dir')),
      outputDirectory: resolve(option(args, '--output-dir')),
      sourceHead: option(args, '--source-head'),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  if (command === 'verify') {
    const manifest = validateAggregateManifest({
      manifestPath: resolve(option(args, '--manifest')),
      binaryDirectory: option(args, '--binary-dir', false) ? resolve(option(args, '--binary-dir', false)) : undefined,
      expectedSourceHead: option(args, '--source-head', false),
    });
    process.stdout.write(`${JSON.stringify(manifest)}\n`);
    return;
  }
  fail('command must be write, aggregate, or verify');
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'secure-store-fs artifact failed'}\n`);
    process.exitCode = 1;
  }
}
