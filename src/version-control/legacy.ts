// Compatibility facade for the historic game-host import path.
//
// Git execution, tag validation, error shaping, and repository policy belong to
// the version-control modules. This file deliberately contains no process
// runner and no second versioning policy; callers should migrate to those
// modules when their API can be made asynchronous.
export {
  createVersion,
  currentVersion,
  ensureGameRepository,
  createCheckpoint,
  listVersions,
  readPackageAtTag,
  readGameFileAtTag,
  type CreatedVersion,
  type CurrentVersion,
  type CreatedCheckpoint,
  type VersionEntry,
} from './compat';
