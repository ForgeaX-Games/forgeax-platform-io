/**
 * Public entry for the platform IO package.
 *
 * The three child barrels keep legacy routers and tools separate from the
 * resource substrate contract while preserving one package-level entry.
 */
export * from './routers';
export * from './tools';
export * from './resource-substrate';
export { createForgeaxVersionAdapter } from './extension-host/version-adapter';
export {
  createForgeaxWorkspaceAdapter,
  type ForgeaxWorkspaceAdapterOptions,
} from './extension-host/workspace-adapter';
export {
  resolveForgeaxGameProjection,
  type ForgeaxGameProjection,
} from './extension-host/game-projection';
export * from './secure-store-fs';
