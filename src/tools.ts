/** Reusable non-router helpers exposed by the platform IO package. */
export {
  readGamePackage,
  writeGamePackage,
  defaultProject,
  classifyGamePackage,
  initializeGamePackage,
  type GamePackageState,
  type GamePackageClassification,
  type GamePackage,
  type WritePackageInput,
} from './api/lib/game-package';
export {
  createVersion as createGameVersion,
  currentVersion as currentGameVersion,
  type CreatedVersion,
  type CurrentVersion,
} from './api/lib/game-git';
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
