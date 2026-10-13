import { defineConfig, devices } from "@playwright/test";

const PORT = 4173;

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
    { name: "desktop", use: { ...devices["Desktop Chrome"] } },
    { name: "phone", use: { ...devices["Pixel 7"] } },
    // The narrowest screen the layout supports, such as a small phone with
    // larger text turned on.
    {
      name: "narrow",
      use: { ...devices["Pixel 7"], viewport: { width: 320, height: 568 } },
    },
  ],
  webServer: {
    command: `CLOUDFLARE_ENV=staging npm run build && npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
