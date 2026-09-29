export type SecureStoreFsTarget =
  | 'darwin-arm64'
  | 'darwin-x64'
  | 'linux-arm64'
  | 'linux-x64';

export interface SecureStoreFsArtifactMetadata {
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly sourceHead: string;
  readonly target: SecureStoreFsTarget;
  readonly bytes: number;
  readonly sha256: string;
}

export interface SecureStoreFsAggregateManifest {
  readonly schemaVersion: 1;
  readonly protocolVersion: string;
  readonly sourceHead: string;
  readonly targets: SecureStoreFsArtifactMetadata[];
}

export const SECURE_STORE_FS_TARGETS: readonly [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
];

export function createArtifactMetadata(options: {
  readonly binaryPath: string;
  readonly target: SecureStoreFsTarget;
  readonly sourceHead: string;
}): SecureStoreFsArtifactMetadata;

export function writeArtifactMetadata(options: {
  readonly binaryPath: string;
  readonly target: SecureStoreFsTarget;
  readonly sourceHead: string;
  readonly metadataPath?: string;
}): SecureStoreFsArtifactMetadata;

export function validateArtifactMetadata(options: {
  readonly binaryPath: string;
  readonly metadataPath: string;
  readonly expectedTarget: SecureStoreFsTarget;
  readonly expectedSourceHead?: string;
}): SecureStoreFsArtifactMetadata;

export function aggregateArtifacts(options: {
  readonly inputDirectory: string;
  readonly outputDirectory: string;
  readonly sourceHead: string;
}): SecureStoreFsAggregateManifest;

export function validateAggregateManifest(options: {
  readonly manifestPath: string;
  readonly binaryDirectory?: string;
  readonly expectedSourceHead?: string;
}): SecureStoreFsAggregateManifest;
