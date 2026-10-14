import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

// Tests that publish posts or add comments.
const WRITES = /(submit|discussion|moderation)\.spec\.ts/;

// Point this at an existing Chromium to skip `npx playwright install chromium`.
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_PATH;

/**
 * End-to-end tests run against a staging build served by `vite preview`, so
 * they exercise the real Content Security Policy rather than the looser
 * development one, with the `/dev/*` review pages still compiled in.
 */
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  reporter: "list",
  use: {
    baseURL: `http://localhost:${PORT}`,
    launchOptions: executablePath ? { executablePath } : {},
  },
  projects: [
    { name: "desktop", use: { ...devices["Desktop Chrome"] }, testIgnore: WRITES },
    { name: "phone", use: { ...devices["Pixel 7"] }, testIgnore: WRITES },
    // The narrowest screen the layout supports, such as a small phone with
    // larger text turned on.
    {
      name: "narrow",
      use: { ...devices["Pixel 7"], viewport: { width: 320, height: 568 } },
      testIgnore: WRITES,
    },
    // Tests that publish posts or add comments run last, so what they add
    // never changes what the feed and thread tests count.
    {
      name: "submit-desktop",
      use: { ...devices["Desktop Chrome"] },
      testMatch: WRITES,
      dependencies: ["desktop", "phone", "narrow"],
    },
    {
      name: "submit-narrow",
      use: { ...devices["Pixel 7"], viewport: { width: 320, height: 568 } },
      testMatch: WRITES,
      dependencies: ["desktop", "phone", "narrow"],
    },
  ],
  webServer: {
    // Builds for staging, fills a local copy of its database with sample
    // posts, and serves the result.
    command: `CLOUDFLARE_ENV=staging npm run build && npm run db:prepare:e2e && NODE_OPTIONS="--require ./e2e/support/preview-fixes.cjs" npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    // Used only where no .dev.vars exists, such as CI: a throwaway signing
    // secret, placeholder Google credentials, and Cloudflare's always-pass
    // Turnstile test secret.
    env: {
      BETTER_AUTH_SECRET: "e2e-only-secret-not-used-anywhere-else-0123456789",
      GOOGLE_CLIENT_ID: "e2e-google-client-id",
      GOOGLE_CLIENT_SECRET: "e2e-google-client-secret",
      TURNSTILE_SECRET_KEY: "1x0000000000000000000000000000000AA",
    },
  },
});
