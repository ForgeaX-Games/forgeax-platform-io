import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import assert from 'node:assert/strict';

test('publishes only the independent compiled package root', () => {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
  assert.equal(pkg.name, '@forgeax/secure-store-fs');
  assert.equal(pkg.private, undefined);
  assert.equal(pkg.packageManager, 'bun@1.4.0');
  assert.equal(pkg.engines.node, '>=18');
  assert.deepEqual(pkg.repository, {
    type: 'git',
    url: 'git+https://github.com/ForgeaX-Games/forgeax-platform-io.git',
    directory: 'packages/secure-store-fs',
  });
  assert.equal(pkg.exports['.'].import, './dist/index.js');
  assert.equal(pkg.exports['.'].types, './dist/index.d.ts');
  assert.deepEqual(pkg.files, ['dist', 'native/secure-store-fs', 'README.md']);
});
