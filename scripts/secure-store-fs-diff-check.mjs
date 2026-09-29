import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const PACKAGE_ROOT = resolve(SCRIPT_DIR, '..');
const SOURCE = resolve(PACKAGE_ROOT, 'native', 'secure-store-fs', 'main.c');
const HEADER = resolve(PACKAGE_ROOT, 'native', 'secure-store-fs', 'protocol.h');
const CLIENT = resolve(PACKAGE_ROOT, 'packages', 'secure-store-fs', 'src', 'client.ts');
const PACKAGE_JSON = resolve(PACKAGE_ROOT, 'packages', 'secure-store-fs', 'package.json');
const WORKFLOW = resolve(PACKAGE_ROOT, '.github', 'workflows', 'secure-store-fs-package.yml');

function fail(message) {
  throw new Error(`secure-store-fs diff-check: ${message}`);
}

function requireText(path, text) {
  if (!existsSync(path) || !readFileSync(path, 'utf8').includes(text)) fail(`missing ${text} in ${path}`);
}

const source = readFileSync(SOURCE, 'utf8');
const header = readFileSync(HEADER, 'utf8');
const client = readFileSync(CLIENT, 'utf8');
const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
const workflow = readFileSync(WORKFLOW, 'utf8');

for (const forbidden of [
  /\bfopen\s*\(/u,
  /\bfreopen\s*\(/u,
  /\bpopen\s*\(/u,
  /\bsystem\s*\(/u,
  /\brealpath\s*\(/u,
  /\brename\s*\(/u,
  /\bunlink\s*\(/u,
  /\bmkdir\s*\(/u,
  /\brmdir\s*\(/u,
]) {
  if (forbidden.test(source)) fail(`path-based or shell primitive matched ${forbidden}`);
}
for (const required of ['openat(', 'fstatat(', 'renameat(', 'unlinkat(', 'mkdirat(', 'linkat(', 'O_NOFOLLOW', 'root_is_still_bound', 'root_components']) {
  if (!source.includes(required)) fail(`required authority primitive ${required} is absent`);
}
for (const required of ['FORGEAX_SECURE_STORE_FS_PROFILE_WIRE', 'FORGEAX_SECURE_STORE_FS_PROFILE_MODEL', 'CREATE_IF_ABSENT', 'FORGEAX_SECURE_STORE_TEST_BARRIERS']) {
  if (!header.includes(required) && !source.includes(required)) fail(`closed contract token ${required} is absent`);
}
if (!source.includes('#ifdef FORGEAX_SECURE_STORE_TEST_BARRIERS')) fail('test barrier code is not compile guarded');
if (
  client.includes('main.c')
  || client.includes('build-secure-store-fs')
  || /spawnSync\s*\(\s*['"](?:cc|clang|gcc)['"]/u.test(client)
) {
  fail('published client contains a source/compiler fallback');
}
if (!client.includes('spawnSync(this.helperPath,')) {
  fail('published synchronous client does not execute the resolved packaged helper');
}
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
  if (!workflow.includes(target)) fail(`workflow target ${target} is absent`);
}
if (!workflow.includes('aggregate') || !workflow.includes('pack:check') || !workflow.includes('clean-consumer')) {
  fail('workflow does not aggregate and run clean-consumer pack gates');
}
if (packageJson.name !== '@forgeax/secure-store-fs' || packageJson.private === true) fail('independent package identity is invalid');
if (packageJson.exports?.['.']?.import !== './dist/index.js' || packageJson.exports?.['.']?.types !== './dist/index.d.ts') {
  fail('independent package export is not compiled JavaScript plus declarations');
}
if (!Array.isArray(packageJson.files) || !packageJson.files.includes('native/secure-store-fs') || !packageJson.files.includes('dist')) {
  fail('independent package files do not carry compiled code and native artifacts');
}

process.stdout.write(JSON.stringify({ ok: true, checked: ['descriptor-relative-syscalls', 'closed-profiles', 'barrier-guard', 'target-matrix', 'package-export'] }) + '\n');
