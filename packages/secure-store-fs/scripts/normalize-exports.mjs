import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = fileURLToPath(new URL('../dist/', import.meta.url));
for (const entry of readdirSync(directory)) {
  if (!entry.endsWith('.js') && !entry.endsWith('.d.ts')) continue;
  const path = join(directory, entry);
  const source = readFileSync(path, 'utf8');
  const normalized = source.replace(/(['"])(\.\.?\/)([A-Za-z0-9_-]+)\1/g, '$1$2$3.js$1');
  if (normalized !== source) writeFileSync(path, normalized);
}
