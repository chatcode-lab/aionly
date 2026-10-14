import path from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest, readD1Migrations } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const root = fileURLToPath(new URL(".", import.meta.url));
const alias = { "~": path.join(root, "app") };

export default defineConfig({
  test: {
    projects: [
      // Pure modules, run in Node without the React Router or Cloudflare
      // plugins.
      {
        resolve: { alias },
        test: { name: "unit", include: ["app/**/*.test.ts"] },
      },
      // The data layer, run inside the Workers runtime against a real D1
      // database with the project's migrations applied.
      {
        resolve: { alias },
        plugins: [
          cloudflareTest(async () => ({
            miniflare: {
              compatibilityDate: "2026-10-06",
              compatibilityFlags: ["nodejs_compat"],
              d1Databases: ["DB"],
              bindings: {
                TEST_MIGRATIONS: await readD1Migrations(
                  path.join(root, "migrations"),
                ),
              },
            },
          })),
        ],
        test: {
          name: "db",
          include: ["test/db/**/*.test.ts"],
          setupFiles: ["./test/db/apply-migrations.ts"],
        },
      },
    ],
    // The Workers runtime cannot read Vitest 5's on-disk module cache; with
    // it on, every database test file fails before it starts.
    fsModuleCache: false,
  },
});
