import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    // Test against workspace sources so tests don't depend on a prior build.
    alias: {
      "@blether/protocol": fileURLToPath(
        new URL("packages/protocol/src/index.ts", import.meta.url),
      ),
    },
  },
  test: {
    include: ["packages/*/src/**/*.test.ts"],
  },
});
