import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pkg = JSON.parse(readFileSync(join(root, 'package.json')));
const targets = ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64'];
if (pkg.name !== '@forgeax/secure-store-fs' || pkg.private === true || pkg.engines?.node !== '>=18') throw new Error('pack contract: package identity/engine is invalid');
if (pkg.exports?.['.']?.import !== './dist/index.js' || pkg.exports?.['.']?.types !== './dist/index.d.ts') throw new Error('pack contract: root export is not compiled');
if (pkg.dependencies && Object.keys(pkg.dependencies).length) throw new Error('pack contract: runtime dependencies are not allowed');
const native = join(root, 'native', 'secure-store-fs');
const manifestPath = join(native, 'manifest.json');
if (!existsSync(manifestPath)) throw new Error('pack contract: aggregate manifest is missing; run the four-target aggregate first');
const manifest = JSON.parse(readFileSync(manifestPath));
if (process.env.FORGEAX_SOURCE_HEAD && manifest.sourceHead !== process.env.FORGEAX_SOURCE_HEAD) throw new Error('pack contract: manifest source head is stale');
if (!Array.isArray(manifest.targets) || manifest.targets.length !== 4 || new Set(manifest.targets.map((row) => row.target)).size !== 4) throw new Error('pack contract: manifest does not contain exactly four targets');
for (const target of targets) {
  const binary = join(native, 'secure-store-fs-' + target);
  if (!existsSync(binary) || !existsSync(binary + '.json') || (statSync(binary).mode & 0o111) === 0) throw new Error('pack contract: missing executable ' + target);
}
const staging = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-pack-'));
try {
  const packed = JSON.parse(execFileSync('npm', ['pack', '--json', '--ignore-scripts', '--pack-destination', staging], { cwd: root, encoding: 'utf8' }));
  const tarball = packed[0]?.filename;
  if (!tarball) throw new Error('pack contract: npm pack produced no tarball');
  execFileSync('tar', ['-xzf', join(staging, tarball), '-C', staging]);
  const packageRoot = join(staging, 'package');
  const files = [];
  const walk = (directory) => { for (const entry of readdirSync(directory, { withFileTypes: true })) { const path = join(directory, entry.name); if (entry.isDirectory()) walk(path); else files.push(path.slice(packageRoot.length + 1)); } };
  walk(packageRoot);
  if (files.some((path) => (path.endsWith('.ts') && !path.endsWith('.d.ts')) || path.endsWith('.c') || path.endsWith('.h') || path.startsWith('scripts/'))) throw new Error('pack contract: source/compiler material leaked into tarball');
  process.stdout.write(JSON.stringify({ ok: true, tarball, targets }) + '\n');
} finally {
  rmSync(staging, { recursive: true, force: true });
}
