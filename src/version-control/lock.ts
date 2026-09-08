const tails = new Map<string, Promise<void>>();

export async function withRepositoryLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = tails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => { release = resolve; });
  tails.set(key, current);
  await previous;
  try { return await operation(); } finally {
    release();
    if (tails.get(key) === current) tails.delete(key);
  }
}
