// Votes and saves still on their way to the server. A navigation waits for
// them, briefly, so the next page loads with them already counted.
const pending = new Set<Promise<unknown>>();

/** Tracks a write until it settles, and returns it. */
export function track<T>(write: Promise<T>): Promise<T> {
  pending.add(write);
  const done = () => pending.delete(write);
  write.then(done, done);
  return write;
}

/** Resolves once every tracked write has settled, or after `limitMs`. */
export function writesSettled(limitMs = 3000): Promise<void> {
  if (pending.size === 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, limitMs);
    void Promise.allSettled([...pending]).then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}
