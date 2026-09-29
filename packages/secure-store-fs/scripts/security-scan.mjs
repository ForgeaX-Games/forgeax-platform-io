import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const source = readFileSync(resolve(root, '../../native/secure-store-fs/main.c'), 'utf8');
for (const token of ['fopen(', 'freopen(', 'popen(', 'system(', 'realpath(', 'rename(', 'unlink(', 'mkdir(', 'rmdir(']) {
  if (source.includes(token)) throw new Error('security scan: forbidden native primitive ' + token);
}
for (const token of ['openat(', 'fstatat(', 'renameat(', 'unlinkat(', 'mkdirat(', 'linkat(', 'O_NOFOLLOW']) {
  if (!source.includes(token)) throw new Error('security scan: required native primitive ' + token + ' is absent');
}
execFileSync(process.execPath, [resolve(root, '../../scripts/secure-store-fs-diff-check.mjs')], { cwd: resolve(root, '../..'), stdio: 'inherit' });
process.stdout.write(JSON.stringify({ ok: true, scan: 'native-source-and-parent-contract' }) + '\n');
