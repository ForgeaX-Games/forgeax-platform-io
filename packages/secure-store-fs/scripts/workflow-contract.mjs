import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const workflow = readFileSync(resolve(root, '../../.github/workflows/secure-store-fs-package.yml'), 'utf8');
if (existsSync(resolve(root, 'package-lock.json'))) throw new Error('workflow contract: foreign package-manager lockfile is committed');
const actionLines = workflow.split('\n').filter((line) => /\buses:\s*/.test(line) && !line.trim().startsWith('#'));
if (actionLines.some((line) => !/@[0-9a-f]{40}(?:\s|$)/.test(line))) throw new Error('workflow contract: every action must use an immutable full SHA');
for (const target of ['darwin-arm64', 'darwin-x64', 'linux-arm64', 'linux-x64']) {
  if (!workflow.includes(target)) throw new Error('workflow contract: missing target ' + target);
}
for (const token of ['FORGEAX_SOURCE_HEAD', 'node-version: 24', 'bun-version: 1.4.0', 'bun install --frozen-lockfile', 'refs/remotes/origin/main', 'npm audit --omit=dev', 'bun run --cwd packages/secure-store-fs pack:check', 'bun run typecheck', 'bun test', 'bun run check:secure-store-fs', 'bun run pack:check', 'npm pack ./packages/secure-store-fs', 'npm publish --access public', '$GITHUB_WORKSPACE/candidate', 'secrets.NPM_TOKEN', 'secure-store-fs-v']) {
  if (!workflow.includes(token)) throw new Error('workflow contract: missing ' + token);
}
process.stdout.write(JSON.stringify({ ok: true, immutableActions: actionLines.length, targets: 4 }) + '\n');
