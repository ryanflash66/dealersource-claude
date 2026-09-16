import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Tests must never reach the network: the offline guard in tests/setup.ts
    // replaces global fetch with one that throws.
    setupFiles: ["tests/setup.ts"],
    pool: "forks",
  },
});
