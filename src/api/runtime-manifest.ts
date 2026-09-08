/**
 * Read Studio runtime endpoint ports from the instance manifest written by
 * `bun fx start` (`.forgeax/runtime/manifest.json`), with env fallbacks.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface StudioRuntimePorts {
  ui: number;
  server: number;
  engine: number;
}

const DEFAULT_PORTS: StudioRuntimePorts = {
  server: 18900,
  ui: 18920,
  engine: 15173,
};

function positivePort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) return null;
  return value;
}

function portFromEnv(env: NodeJS.ProcessEnv, keys: readonly string[], fallback: number): number {
  for (const key of keys) {
    const raw = env[key];
    if (!raw) continue;
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return fallback;
}

/** Parse `.forgeax/runtime/manifest.json` when present. */
export function readStudioRuntimePorts(projectRoot: string): StudioRuntimePorts | null {
  const manifestPath = join(projectRoot, '.forgeax', 'runtime', 'manifest.json');
  if (!existsSync(manifestPath)) return null;
  try {
    const raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      endpoints?: {
        server?: { port?: unknown };
        interface?: { port?: unknown };
        engine?: { port?: unknown };
      };
      ports?: { server?: unknown; interface?: unknown; engine?: unknown };
    };
    const server = positivePort(raw.endpoints?.server?.port ?? raw.ports?.server);
    const ui = positivePort(raw.endpoints?.interface?.port ?? raw.ports?.interface);
    const engine = positivePort(raw.endpoints?.engine?.port ?? raw.ports?.engine);
    if (server === null || ui === null || engine === null) return null;
    return { server, ui, engine };
  } catch {
    return null;
  }
}

export function studioRuntimePortsFromEnv(env: NodeJS.ProcessEnv = process.env): StudioRuntimePorts {
  return {
    server: portFromEnv(env, ['FORGEAX_SERVER_PORT', 'FORGEAX_DESKTOP_SERVER_PORT'], DEFAULT_PORTS.server),
    ui: portFromEnv(env, ['FORGEAX_INTERFACE_PORT'], DEFAULT_PORTS.ui),
    engine: portFromEnv(env, ['FORGEAX_ENGINE_PORT', 'FORGEAX_DESKTOP_ENGINE_PORT'], DEFAULT_PORTS.engine),
  };
}

export function resolveStudioRuntimePorts(
  projectRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): StudioRuntimePorts {
  return readStudioRuntimePorts(projectRoot) ?? studioRuntimePortsFromEnv(env);
}
