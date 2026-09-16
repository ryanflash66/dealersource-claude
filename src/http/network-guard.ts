/**
 * Offline guard: replaces global fetch so that ANY attempt to reach the
 * network throws loudly. The pipeline installs it for --offline runs and the
 * test setup installs it for every test, which is how "no network" is proven
 * rather than assumed.
 */
export class NetworkDisabledError extends Error {
  constructor(url: string) {
    super(`Network access is disabled in offline mode (attempted ${url})`);
  }
}

let original: typeof fetch | null = null;

export function installNetworkGuard(): void {
  if (original) return;
  original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    throw new NetworkDisabledError(url);
  }) as typeof fetch;
}

export function uninstallNetworkGuard(): void {
  if (original) {
    globalThis.fetch = original;
    original = null;
  }
}

export function networkGuardInstalled(): boolean {
  return original !== null;
}
