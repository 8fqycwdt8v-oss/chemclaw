import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // Tests run as "dev". The LOG_USER_SALT helper throws when
    // CHEMCLAW_DEV_MODE != "true" so a production deploy can't silently
    // fall back to the public dev salt; Vitest doesn't set this on its
    // own so we declare it once for the whole test process.
    env: {
      CHEMCLAW_DEV_MODE: "true",
    },
    coverage: {
      provider: "v8",
      reporter: ["text-summary", "lcov", "json-summary"],
      include: ["src/**"],
      // CI feeds lcov.info into diff-cover; the json-summary is for
      // local "coverage went up/down" checks.
      reportsDirectory: "coverage",
    },
  },
});
