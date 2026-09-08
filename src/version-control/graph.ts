import { resolveRepositoryExecutable } from './root';
import { runGit } from './process';
import { validateTagName, type TagRef } from './tag';
import { readLatestRef } from './latest-ref';

export { validateTagName } from './tag';

export interface VersionGraphNode {
  commit: string;
  tags: readonly string[];
  /** Commit subject, kept separate from an annotated tag message. */
  message: string;
  /** Git committer time in epoch seconds; used for newest-first projections. */
  committedAt: number;
  latest?: boolean;
}
export interface VersionGraph { nodes: VersionGraphNode[]; edges: Array<{ from: string; to: string }> }

export async function listTagRefs(gameRoot: string): Promise<TagRef[]> {
  const executable = await resolveRepositoryExecutable();
  const output = runGit({ executable, cwd: gameRoot, args: ['for-each-ref', 'refs/tags', '--format=%(refname:strip=2)\t%(objectname)\t%(objecttype)\t%(subject)'] }).stdout;
  const refs: TagRef[] = [];
  for (const line of output.split('\n').filter(Boolean)) {
    const [tag, object, type, ...message] = line.split('\t');
    if (!tag || !validateTagName(tag)) continue;
    const commit = await (async () => {
      try { return runGit({ executable, cwd: gameRoot, args: ['rev-parse', `${tag}^{commit}`] }).stdout.trim(); } catch { return ''; }
    })();
    if (commit) refs.push({ tag, commit, annotated: type === 'tag', message: message.join('\t') });
    void object;
  }
  return refs;
}

async function parents(gameRoot: string, commit: string): Promise<string[]> {
  const executable = await resolveRepositoryExecutable();
  const line = runGit({ executable, cwd: gameRoot, args: ['rev-list', '--parents', '-n', '1', commit] }).stdout.trim();
  return line.split(/\s+/).slice(1);
}

async function commitMetadata(gameRoot: string, commits: readonly string[]): Promise<Map<string, { message: string; committedAt: number }>> {
  if (commits.length === 0) return new Map();
  const executable = await resolveRepositoryExecutable();
  const output = runGit({
    executable,
    cwd: gameRoot,
    // Ask Git for exactly the visible commits in one process. This avoids a
    // per-node `show` call while keeping snapshot latency bounded for large
    // tagged histories.
    args: ['log', '--no-walk', '--format=%H%x09%ct%x09%s', ...commits],
  }).stdout;
  const metadata = new Map<string, { message: string; committedAt: number }>();
  const visibleCommits = new Set(commits);
  for (const line of output.split('\n').filter(Boolean)) {
    const [commit, rawTime, ...message] = line.split('\t');
    if (!commit || !visibleCommits.has(commit)) continue;
    const committedAt = Number(rawTime);
    metadata.set(commit, {
      message: message.join('\t'),
      committedAt: Number.isFinite(committedAt) ? committedAt : 0,
    });
  }
  return metadata;
}

export async function buildVersionGraph(gameRoot: string): Promise<VersionGraph> {
  const refs = await listTagRefs(gameRoot);
  const byCommit = new Map<string, string[]>();
  for (const ref of refs) byCommit.set(ref.commit, [...(byCommit.get(ref.commit) ?? []), ref.tag]);
  const executable = await resolveRepositoryExecutable();
  let head: string | null = null;
  try { head = runGit({ executable, cwd: gameRoot, args: ['rev-parse', 'HEAD'] }).stdout.trim(); } catch { /* unborn */ }
  const latestRef = await readLatestRef(gameRoot);
  const latestCandidate = latestRef ?? head;
  const latest = latestCandidate && !byCommit.has(latestCandidate) ? latestCandidate : null;
  const nodes = [...byCommit.entries()].map(([commit, tags]) => ({
    commit,
    tags: tags.sort(),
    ...(commit === latest ? { latest: true } : {}),
  }));
  if (latest && !byCommit.has(latest)) nodes.push({ commit: latest, tags: [], latest: true });
  const metadata = await commitMetadata(gameRoot, nodes.map((node) => node.commit));
  const enrichedNodes = nodes.map((node) => ({
    ...node,
    message: metadata.get(node.commit)?.message ?? '',
    committedAt: metadata.get(node.commit)?.committedAt ?? 0,
  }));
  enrichedNodes.sort((left, right) => right.committedAt - left.committedAt || right.commit.localeCompare(left.commit));
  const visible = new Set(enrichedNodes.map((node) => node.commit));
  const edges: Array<{ from: string; to: string }> = [];
  for (const node of enrichedNodes) {
    const queue = [...await parents(gameRoot, node.commit)];
    const seen = new Set<string>();
    while (queue.length) {
      const candidate = queue.shift()!;
      if (seen.has(candidate)) continue;
      seen.add(candidate);
      if (visible.has(candidate)) { edges.push({ from: node.commit, to: candidate }); continue; }
      queue.push(...await parents(gameRoot, candidate));
    }
  }
  return { nodes: enrichedNodes, edges };
}
