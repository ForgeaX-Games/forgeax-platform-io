/** agent-pack —— 中立的「把一份 agent-pack 落到用户可写插件层」IO primitive。
 *
 *  背景:产品层的 `team:create_role` 工具要让 LLM「铸造新队友」——把一份
 *  agent-pack(forgeax-plugin.json kind:agent + persona/zh.md + 可选 memory)写进
 *  L1(`~/.forgeax/plugins`)或 L2(`<projectRoot>/.forgeax/plugins`)。写盘本身是
 *  纯 IO,属于 platform-io 这层最通用的底座(见本包 .dependency-cruiser.cjs:零上行)。
 *
 *  分工:本 primitive **只负责把已组装、已校验的字节落到磁盘**——
 *    - manifest 的 zod 校验(parseManifest)与撞名查重发生在调用方(cli host 缝),
 *      因为那需要 `@forgeax/types` 与 plugin snapshot,platform-io 不得上行依赖;
 *    - 这里只做 slug/persona 的基本非空检查 + 目录存在即拒(照 fork.ts 的
 *      `{code:'exists'}` 幂等策略,绝不静默覆盖)。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { defaultProjectRoot } from './safe-path';

export type AgentPackScope = 'global' | 'project';

export interface AgentPackFiles {
  /** 落盘目录名(插件层根下的一级目录),如 `agent-scout`。仅 [A-Za-z0-9._-]。 */
  slug: string;
  /** forgeax-plugin.json 的内容(调用方已组装 + 校验;这里只 JSON.stringify)。 */
  manifest: unknown;
  /** 角色 system 提示词 → persona/zh.md。 */
  persona: string;
  /** 可选记忆种子 → memory/lessons.md。 */
  memorySeed?: string;
}

export interface WriteAgentPackOpts {
  scope: AgentPackScope;
  /** scope='project' 时的工程根;缺省取 defaultProjectRoot()。 */
  projectRoot?: string;
}

export type WriteAgentPackResult =
  | { ok: true; dir: string; scope: AgentPackScope }
  | { ok: false; code: 'exists' | 'bad_input' | 'fs_error'; error: string };

/** 解析某 scope 的插件层根目录。
 *  global → `~/.forgeax/plugins`(L1);project → `<projectRoot>/.forgeax/plugins`(L2)。 */
export function agentPackLayerRoot(scope: AgentPackScope, projectRoot?: string): string {
  return scope === 'global'
    ? resolve(homedir(), '.forgeax', 'plugins')
    : resolve(projectRoot ?? defaultProjectRoot(), '.forgeax', 'plugins');
}

function ensureTrailingNewline(s: string): string {
  return s.endsWith('\n') ? s : `${s}\n`;
}

/** 把一份 agent-pack 写入 L1/L2。目录已存在则拒(不覆盖)。 */
export function writeAgentPack(files: AgentPackFiles, opts: WriteAgentPackOpts): WriteAgentPackResult {
  if (!files.slug || !/^[A-Za-z0-9._-]+$/.test(files.slug)) {
    return { ok: false, code: 'bad_input', error: `invalid agent-pack slug: ${JSON.stringify(files.slug)}` };
  }
  if (typeof files.persona !== 'string' || !files.persona.trim()) {
    return { ok: false, code: 'bad_input', error: 'persona is required and must be non-empty' };
  }
  const root = agentPackLayerRoot(opts.scope, opts.projectRoot);
  const dir = join(root, files.slug);
  if (existsSync(dir)) {
    return { ok: false, code: 'exists', error: `agent-pack dir already exists: ${dir}` };
  }
  try {
    mkdirSync(join(dir, 'persona'), { recursive: true });
    writeFileSync(
      join(dir, 'forgeax-plugin.json'),
      `${JSON.stringify(files.manifest, null, 2)}\n`,
      'utf-8',
    );
    writeFileSync(join(dir, 'persona', 'zh.md'), ensureTrailingNewline(files.persona), 'utf-8');
    if (files.memorySeed && files.memorySeed.trim()) {
      mkdirSync(join(dir, 'memory'), { recursive: true });
      writeFileSync(join(dir, 'memory', 'lessons.md'), ensureTrailingNewline(files.memorySeed), 'utf-8');
    }
  } catch (e) {
    return { ok: false, code: 'fs_error', error: (e as Error).message };
  }
  return { ok: true, dir, scope: opts.scope };
}
