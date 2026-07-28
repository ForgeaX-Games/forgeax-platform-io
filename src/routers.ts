/** Public HTTP router factories and their host-facing seams. */
export { createFilesRouter } from './api/files';
export {
  type FileBackend,
  studioFileBackend,
  singleGameFileBackend,
  WHITELIST_ERROR,
} from './api/lib/file-backend';
export { createFsBrowserRouter } from './api/fs-browser';
export { createGameAssetsRouter } from './api/game-assets';
export { createGameHostRouter, type GameHostOptions } from './api/game-host';
export { createProjectsRouter, PROJECT_ID_RE } from './api/projects';
export { createLogsRouter, logsDir, appendToStream } from './api/logs';
export { createVersionRouter, getVersion } from './api/version';
export { createChangelogRouter, parseChangelog } from './api/changelog';
export { createPrefsRouter } from './api/prefs';
export { createBootSplashRouter } from './api/boot-splash';
