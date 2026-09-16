/**
 * Offline guard: replaces global fetch so that ANY attempt to reach the
 * network throws loudly. The pipeline installs it for --offline runs and the
 * test setup installs it for every test, which is how "no network" is proven
 * rather than assumed. Reference-counted so nested installs are safe.
 */
export class NetworkDisabledError extends Error {
  constructor(url: string) {
    super(`Network access is disabled in offline mode (attempted ${url})`);
  }
}

let original: typeof fetch | null = null;
let depth = 0;

/** Installs the guard; returns a release function that undoes THIS install only. */
export function installNetworkGuard(): () => void {
  if (depth === 0) {
    original = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      throw new NetworkDisabledError(url);
    }) as typeof fetch;
  }
  depth++;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    depth--;
    if (depth === 0 && original) {
      globalThis.fetch = original;
      original = null;
    }
  };
}

export function networkGuardInstalled(): boolean {
  return depth > 0;
}
