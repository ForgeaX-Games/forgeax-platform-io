import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

function option(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) throw new Error('clean consumer: missing ' + name);
  return process.argv[index + 1];
}

const tarball = resolve(option('--package'));
const target = option('--target');
const temporary = mkdtempSync(join(tmpdir(), 'forgeax-secure-store-clean-consumer-'));
try {
  execFileSync('tar', ['-xzf', tarball, '-C', temporary]);
  const packageRoot = join(temporary, 'package');
  const packageJson = JSON.parse(readFileSync(join(packageRoot, 'package.json')));
  if (packageJson.name !== '@forgeax/secure-store-fs') throw new Error('clean consumer: wrong package');
  const nativeRoot = join(packageRoot, 'native', 'secure-store-fs');
  const helper = join(nativeRoot, 'secure-store-fs-' + target);
  if (!existsSync(helper)) throw new Error('clean consumer: target helper is missing');
  const consumer = join(temporary, 'consumer');
  mkdirSync(join(consumer, 'node_modules', '@forgeax'), { recursive: true, mode: 0o700 });
  symlinkSync(packageRoot, join(consumer, 'node_modules', '@forgeax', 'secure-store-fs'), 'dir');
  const script = join(consumer, 'consumer.mjs');
  writeFileSync(script, [
    "import { mkdtemp, realpath, rm } from 'node:fs/promises';",
    "import { tmpdir } from 'node:os';",
    "import { join } from 'node:path';",
    "import { createSecureStoreFsClient, resolveSecureStoreFsBroker } from '@forgeax/secure-store-fs';",
    "const packageRoot = process.env.FORGEAX_PACKED_PACKAGE_ROOT;",
    "const target = process.env.FORGEAX_PACKED_TARGET;",
    "const info = resolveSecureStoreFsBroker();",
    "if (info.target !== target) throw new Error('clean consumer: wrong target');",
    "const realPackageRoot = await realpath(packageRoot);",
    "const realHelper = await realpath(info.path);",
    "if (!realHelper.startsWith(join(realPackageRoot, 'native', 'secure-store-fs') + '/')) throw new Error('clean consumer: helper escaped package');",
    "const root = await mkdtemp(join(tmpdir(), 'forgeax-secure-store-consumer-root-'));",
    "const client = createSecureStoreFsClient({ root, profile: 'model-exchange-v1' });",
    "try { await client.ensureLayout(); const name = '" + "a".repeat(64) + ".json'; if (!await client.createIfAbsent('blobs', name, new TextEncoder().encode('clean\\n'))) throw new Error('create failed'); const bytes = await client.read('blobs', name); if (new TextDecoder().decode(bytes) !== 'clean\\n') throw new Error('read failed'); } finally { await client.close(); await rm(root, { recursive: true, force: true }); }",
  ].join('\n'));
  execFileSync(process.execPath, [script], {
    cwd: consumer,
    env: {
      ...process.env,
      CC: '/definitely/missing/forgeax-compiler',
      CXX: '/definitely/missing/forgeax-cxx',
      FORGEAX_SECURE_STORE_FS_DISABLE_SOURCE_FALLBACK: '1',
      FORGEAX_PACKED_PACKAGE_ROOT: packageRoot,
      FORGEAX_PACKED_TARGET: target,
    },
    stdio: 'inherit',
  });
  process.stdout.write(JSON.stringify({ ok: true, target, package: packageJson.name + '@' + packageJson.version }) + '\n');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
