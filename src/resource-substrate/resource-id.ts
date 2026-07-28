/** Validation for root-scoped, POSIX-like logical resource identifiers. */
import {
  createResourceError,
  type ResourceId,
  type ResourceResult,
} from './contract';

export const RESOURCE_CONTROL_PREFIXES = ['.resource-substrate', '.forgeax'] as const;

function invalidResourceId(
  input: unknown,
  code: 'invalid-resource-id' | 'root-boundary-violation',
): ResourceResult<ResourceId> {
  return {
    ok: false,
    error: createResourceError(code, {
      actual: typeof input === 'string' ? input : String(input),
      expected: 'a relative POSIX-like logical resource id',
      resourceId: typeof input === 'string' ? input : undefined,
    }),
  };
}

export function normalizeResourceId(input: unknown): ResourceResult<ResourceId> {
  if (typeof input !== 'string' || input.length === 0) {
    return invalidResourceId(input, 'invalid-resource-id');
  }

  if (
    input.startsWith('/') ||
    /^[A-Za-z]:[\\/]/.test(input) ||
    input.includes('\\') ||
    input.includes('\0') ||
    input.includes('//') ||
    input.endsWith('/')
  ) {
    return invalidResourceId(input, 'root-boundary-violation');
  }

  const segments = input.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    return invalidResourceId(input, segmentEscape(input) ? 'root-boundary-violation' : 'invalid-resource-id');
  }

  if (RESOURCE_CONTROL_PREFIXES.some((prefix) => input === prefix || input.startsWith(`${prefix}/`))) {
    return invalidResourceId(input, 'invalid-resource-id');
  }

  if (/[\x00-\x1F\x7F]/.test(input)) {
    return invalidResourceId(input, 'invalid-resource-id');
  }

  return { ok: true, value: input as ResourceId };
}

function segmentEscape(input: string): boolean {
  return input.split('/').some((segment) => segment === '..');
}

export function isResourceId(input: unknown): input is ResourceId {
  return normalizeResourceId(input).ok;
}
