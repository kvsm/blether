import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const source = (pkg: string) =>
  fileURLToPath(new URL(`packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    // Test against workspace sources so tests don't depend on a prior build.
    alias: {
      "@blether/protocol": source("protocol"),
      "@blether/bridge": source("bridge"),
      "@blether/relay": source("relay"),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts", "e2e/**/*.test.ts"],
  },
});
