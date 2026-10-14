import { applyD1Migrations } from "cloudflare:test";
import { env } from "cloudflare:workers";

// Runs before each test file. Applying migrations twice is a no-op.
await applyD1Migrations(env.DB, env.TEST_MIGRATIONS);
