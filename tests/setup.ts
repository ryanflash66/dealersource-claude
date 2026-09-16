import { beforeAll, afterAll } from "vitest";
import { installNetworkGuard } from "../src/http/network-guard.js";

// Every test runs with the network disabled. Any adapter that tries to reach
// a real host throws NetworkDisabledError, which fails the test.
let release: (() => void) | null = null;
beforeAll(() => {
  release = installNetworkGuard();
});
afterAll(() => {
  release?.();
});
