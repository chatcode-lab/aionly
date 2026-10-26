import type { Page } from "@playwright/test";

import { expect, open, test } from "./fixtures";

// The founder's invitation to the digest (owner's request, 2026-10-26).
test.use({ digestInvite: true });

const TITLE = "The best of aion.ly, by email";

/** Scrolls a screen and a half, as a reader would, once the page has seen it. */
async function scrollAScreen(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        addEventListener("scroll", () => resolve(), { once: true });
        scrollBy(0, innerHeight * 1.5);
      }),
  );
}

/**
 * Where the shared link sends the browser on, and the cookies it sets, as
 * the next form sent there starts the sign-in. The browser stops at a blank
 * page of the board's own: the fixtures' stand-ins catch only the first
 * address of a redirect, so Google's would otherwise be reached.
 */
async function signInStart(page: Page): Promise<{ location: Promise<string>; cookies: Promise<string[]> }> {
  let resolve: (value: { location: string; cookies: string[] }) => void = () => {};
  const started = new Promise<{ location: string; cookies: string[] }>((done) => (resolve = done));
  await page.route(
    (url) => url.pathname === "/join/boris",
    async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      const response = await route.fetch({ maxRedirects: 0 });
      resolve({
        location: response.headers().location ?? "",
        cookies: response.headersArray().flatMap((header) => (header.name.toLowerCase() === "set-cookie" ? [header.value] : [])),
      });
      await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>On to Google</title>" });
    },
  );
  return { location: started.then((value) => value.location), cookies: started.then((value) => value.cookies) };
}

/** Reads a while: a screen's scroll, then long enough on the page, pausing at the end. */
async function readAWhile(page: Page): Promise<void> {
  await scrollAScreen(page);
  await page.clock.runFor(25_000);
}

test("a visitor who reads a while is invited to join for the digest, and once closed it stays away", async ({ page }) => {
  await page.clock.install();
  await open(page, "/");
  const invite = page.getByRole("dialog", { name: TITLE });
  // Time alone is not interest.
  await page.clock.runFor(25_000);
  await expect(invite).toHaveCount(0);
  // A screen's scroll is, once the visitor pauses.
  await scrollAScreen(page);
  await page.clock.runFor(1_000);
  await expect(invite).toHaveCount(0);
  await page.clock.runFor(4_000);
  await expect(invite).toBeVisible();
  await expect(invite).toContainText("Boris Karulin");
  await expect(invite).toContainText("Founder of aion.ly");
  // It takes no focus, so the page goes on as it was.
  expect(await invite.evaluate((card) => card.contains(document.activeElement))).toBe(false);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);

  // Daily first; the three alone, with nothing more to read (owner's request, 2026-10-26).
  await expect(invite.getByRole("radio", { name: "Daily" })).toBeChecked();
  await expect(invite.getByRole("radio")).toHaveCount(3);
  await expect(invite).not.toContainText("Every morning");
  await invite.getByText("Weekly", { exact: true }).click();
  await expect(invite.getByRole("radio", { name: "Weekly" })).toBeChecked();

  // Closed, it stays away, on the next visit too; the top bar's button keeps its dot.
  await invite.getByRole("button", { name: "Close" }).click();
  await expect(invite).toHaveCount(0);
  await expect(page.locator("header").getByRole("link", { name: "Email digest" }).locator("span")).toHaveCount(1);
  await page.evaluate(() => sessionStorage.clear());
  await open(page, "/");
  await readAWhile(page);
  await expect(invite).toHaveCount(0);
});

test("opening a post counts as interest; the invitation shows once a visit, and Escape or Not now closes it", async ({ page }) => {
  await page.clock.install();
  await open(page, "/");
  await page.locator('main article a[href^="/p/"]').first().click();
  await expect(page).toHaveURL(/\/p\//);
  await page.clock.runFor(25_000);
  const invite = page.getByRole("dialog", { name: TITLE });
  await expect(invite).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(invite).toHaveCount(0);

  // Not closed, but shown already: not again this visit.
  await page.evaluate(() => localStorage.clear());
  await open(page, "/");
  await readAWhile(page);
  await expect(invite).toHaveCount(0);

  // On the next visit it may show again, and Not now closes it too.
  await page.evaluate(() => sessionStorage.clear());
  await open(page, "/");
  await readAWhile(page);
  await expect(invite).toBeVisible();
  const notNow = invite.getByRole("button", { name: "Not now" });
  if (page.viewportSize()!.width < 360) {
    // No room for it beside Continue with Google there; Close, above, is.
    await expect(notNow).toBeHidden();
    await invite.getByRole("button", { name: "Close" }).click();
  } else {
    await notNow.click();
  }
  await expect(invite).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("aionly:digest-invite-closed"))).toMatch(/^\d+$/);
});

test("members never see it, nor do visitors on pages other than the feed and posts", async ({ page, context, account }) => {
  await page.clock.install();
  await open(page, "/manifesto");
  await readAWhile(page);
  const invite = page.getByRole("dialog", { name: TITLE });
  await expect(invite).toHaveCount(0);

  await account.signIn(context);
  await open(page, "/");
  await readAWhile(page);
  await expect(invite).toHaveCount(0);
});

test("Continue with Google keeps the shared link and the digest chosen for the sign-up", async ({ page }) => {
  await page.clock.install();
  await open(page, "/");
  await readAWhile(page);
  const invite = page.getByRole("dialog", { name: TITLE });
  await invite.getByText("Monthly", { exact: true }).click();
  const start = await signInStart(page);
  await invite.getByRole("button", { name: "Continue with Google" }).click();
  const location = new URL(await start.location);
  expect(location.origin).toBe("https://accounts.google.com");
  expect(location.searchParams.get("redirect_uri")).toMatch(/\/api\/auth\/callback\/google$/);
  const cookies = await start.cookies;
  expect(cookies.some((cookie) => cookie.startsWith("aionly_partner=boris;"))).toBe(true);
  expect(cookies.some((cookie) => cookie.startsWith("aionly_digest=monthly;"))).toBe(true);
  // Left for Google, it stays away a while, as when closed.
  await page.goBack();
  expect(await page.evaluate(() => localStorage.getItem("aionly:digest-invite-closed"))).toMatch(/^\d+$/);
});

test("the welcome step names the digest the account starts with", async ({ page, context, account }) => {
  await account.signIn(context);
  for (const [choice, words] of [
    ["Daily", "Each morning we'll email you the board's best posts"],
    ["Weekly", "Each Monday we'll email you the week's best posts"],
    ["Monthly", "Early each month we'll email you the month's best posts"],
  ]) {
    await open(page, "/");
    await page.locator("header").getByRole("button", { name: /^Email digest/ }).click();
    await Promise.all([
      page.waitForResponse((response) => new URL(response.url()).pathname.startsWith("/api/digest") && response.ok()),
      page.getByRole("menuitemradio", { name: choice, exact: true }).click(),
    ]);
    await open(page, "/welcome");
    await expect(page.getByText(words)).toBeVisible();
  }
});

test.describe("without scripts", () => {
  test.use({ javaScriptEnabled: false });

  test("the digest's own page takes the choice to Google", async ({ page }) => {
    await page.goto("/join/boris?digest=weekly");
    await expect(page.getByRole("heading", { name: TITLE })).toBeVisible();
    await expect(page.getByRole("radio", { name: "Weekly" })).toBeChecked();
    await page.getByText("Monthly", { exact: true }).click();
    const start = await signInStart(page);
    await page.getByRole("button", { name: "Continue with Google" }).click();
    expect(new URL(await start.location).origin).toBe("https://accounts.google.com");
    expect((await start.cookies).some((cookie) => cookie.startsWith("aionly_digest=monthly;"))).toBe(true);
  });
});

test.describe("inside an app's browser", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0",
  });

  test("it offers the digest's own page, with the choice, to open in a real browser", async ({ page, context, baseURL }) => {
    await context.grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.clock.install();
    await open(page, "/");
    await readAWhile(page);
    const invite = page.getByRole("dialog", { name: TITLE });
    await expect(invite).toContainText("does not work inside Instagram");
    await expect(invite.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
    await invite.getByText("Weekly", { exact: true }).click();
    await invite.getByRole("button", { name: "Copy link" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(new URL("/join/boris?digest=weekly", baseURL).href);
  });
});

test("the top bar's digest button, with a dot each visit until it is used, opens the invitation on any page", async ({ page }) => {
  await open(page, "/manifesto");
  const button = page.locator("header").getByRole("link", { name: "Email digest" });
  const dot = button.locator("span");
  // Before the page's scripts run, it is the digest's own join page.
  await expect(button).toHaveAttribute("href", "/join/boris?digest=daily&next=%2Fmanifesto");
  await expect(dot).toHaveCount(1);
  await button.click();
  const invite = page.getByRole("dialog", { name: TITLE });
  await expect(invite).toBeVisible();
  await expect(invite).toBeFocused();
  await expect(button).toHaveAttribute("aria-expanded", "true");
  await expect(dot).toHaveCount(0);
  // Again, it closes, and focus goes back to the button.
  await button.click();
  await expect(invite).toHaveCount(0);
  await button.click();
  await page.keyboard.press("Escape");
  await expect(invite).toHaveCount(0);
  await expect(button).toBeFocused();

  // Opened elsewhere, it goes with the visitor to the feed; another page closes it.
  await button.click();
  await page.getByRole("link", { name: "aion.ly home" }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(invite).toBeVisible();
  // Submit, which leads a visitor to sign in.
  await page.locator("header").getByRole("link", { name: "Submit a post" }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fsubmit$/);
  await expect(invite).toHaveCount(0);

  // Used, the dot stays away for the rest of the visit, and is back on the next,
  // though the invitation stays away by itself after it was closed.
  await open(page, "/");
  await expect(button).toBeVisible();
  await expect(dot).toHaveCount(0);
  await page.evaluate(() => sessionStorage.clear());
  await open(page, "/");
  await expect(dot).toHaveCount(1);
});

test("members have their own digest menu, not the invitation", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/");
  await expect(page.locator("header").getByRole("link", { name: "Email digest" })).toHaveCount(0);
  await expect(page.locator("header").getByRole("button", { name: /^Email digest:/ })).toBeVisible();
});
