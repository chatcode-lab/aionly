import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

// Unit tests for pure modules. They run without the React Router and
// Cloudflare plugins; D1 integration tests will use the Workers pool.
export default defineConfig({
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./app", import.meta.url)),
    },
  },
  test: {
    include: ["app/**/*.test.ts", "workers/**/*.test.ts"],
  },
});
