import { test as base, expect } from "@playwright/test";

export interface PageProblems {
  /** Console errors and uncaught exceptions. */
  errors: string[];
  /** Content Security Policy violations reported in the top document. */
  violations: string[];
}

/**
 * Every test runs offline from third parties: requests that leave the app are
 * answered with an empty body, so nothing depends on a provider being up and
 * no test traffic reaches them. Problems the page reports are collected for
 * assertions.
 */
export const test = base.extend<{ problems: PageProblems }>({
  problems: async ({ page, baseURL }, use) => {
    const problems: PageProblems = { errors: [], violations: [] };
    const appOrigin = new URL(baseURL!).origin;

    await page.route(
      (url) => url.origin !== appOrigin && url.protocol.startsWith("http"),
      (route) => route.fulfill({ status: 200, contentType: "text/html", body: "" }),
    );

    page.on("console", (message) => {
      if (message.type() !== "error") return;
      const text = message.text();
      if (/Content Security Policy|Refused to/i.test(text)) {
        problems.violations.push(text);
      } else {
        problems.errors.push(text);
      }
    });
    page.on("pageerror", (error) => problems.errors.push(String(error)));

    await use(problems);
  },
});

export { expect };
