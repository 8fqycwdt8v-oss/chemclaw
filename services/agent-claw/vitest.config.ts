import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
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
