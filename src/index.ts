/**
 * @forgeax/platform-io — 后端 L1 平台 IO 基建 barrel。
 *
 * 10 个纯 IO router 工厂 + 复用工具(safe-path / friendly-path / io /
 * asset-root / known-projects / scaffold)。R1 从 forgeax-cli 抽出,
 * 由 cli(后L2)经 createForgeaxApp 挂载、server(后L3)直接复用、
 * 将来 editor(前L2)standalone 直连。零 agent/session/llm 依赖。
 */

// ── Router 工厂(app.ts 经此挂载 /api/*) ──────────────────────────────
export { createFilesRouter } from './api/files';
// /api/files 的落盘约束 seam(R3):studio 多项目 vs editor 单游戏复用同一 router。
export {
  type FileBackend,
  studioFileBackend,
  singleGameFileBackend,
  WHITELIST_ERROR,
} from './api/lib/file-backend';
export { createFsBrowserRouter } from './api/fs-browser';
export { createAssetsRouter } from './api/assets';
export { createGameAssetsRouter } from './api/game-assets';
export { createProjectsRouter, PROJECT_ID_RE } from './api/projects';
export { createLogsRouter, logsDir, appendToStream } from './api/logs';
export { createVersionRouter, getVersion } from './api/version';
export { createChangelogRouter, parseChangelog } from './api/changelog';
export { createPrefsRouter } from './api/prefs';
export { createBootSplashRouter } from './api/boot-splash';

// ── 复用工具(cli/server 留存代码 re-point 到这里) ──────────────────
export { defaultProjectRoot, resolveSafePath, ALLOWED_TOP_DIRS } from './api/lib/safe-path';
export { friendlyPath } from './api/lib/friendly-path';
export {
  classify,
  readFileSafe,
  writeFileSafe,
  listTree,
  type FileKind,
  type FileInfo,
  type TreeNode,
} from './api/lib/io';
export {
  knownProjectsFile,
  loadKnown,
  addKnown,
  removeKnown,
  type KnownProject,
} from './api/lib/known-projects';
export {
  scaffoldDefaultWorkspace,
  type ScaffoldResult,
} from './api/lib/scaffold-default-workspace';
export { assetRoot, mp, interfaceDist } from './lib/asset-root';
export { readUninstalledAgentIds, writeUninstalledAgentIds } from './api/lib/agent-prefs';
export {
  writeAgentPack,
  agentPackLayerRoot,
  type AgentPackFiles,
  type AgentPackScope,
  type WriteAgentPackOpts,
  type WriteAgentPackResult,
} from './api/lib/agent-pack';
