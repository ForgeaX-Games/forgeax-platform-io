import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const sourceHead = process.env.FORGEAX_SOURCE_HEAD ?? '';
if (!/^[a-f0-9]{40}$/.test(sourceHead)) throw new Error('release provenance: source head must be a full lowercase commit SHA');
const ref = process.env.GITHUB_REF ?? '';
const tag = ref.startsWith('refs/tags/') ? ref.slice('refs/tags/'.length) : undefined;
if (tag && tag !== 'secure-store-fs-v' + pkg.version) throw new Error('release provenance: tag does not match package version');
if (tag) {
  const taggedHead = execFileSync('git', ['rev-list', '-n', '1', tag], { encoding: 'utf8' }).trim();
  if (taggedHead !== sourceHead) throw new Error('release provenance: tag does not point at source head');
  const ancestry = execFileSync('git', ['merge-base', '--is-ancestor', sourceHead, 'refs/remotes/origin/main'], { encoding: 'utf8' });
  if (ancestry.length !== 0) throw new Error('release provenance: unexpected ancestry output');
}
process.stdout.write(JSON.stringify({ name: pkg.name, version: pkg.version, sourceHead, tag: tag ?? null }) + '\n');
