import { expect, open, test } from "./fixtures";

test("signed out, the top bar offers Sign in, which explains Google sign-in", async ({ page }) => {
  await open(page, "/");
  const header = page.locator("header");
  await expect(header.getByRole("button", { name: "Account:" })).toHaveCount(0);
  // Before the page's scripts run, it is a link to the sign-in page.
  await expect(header.getByRole("link", { name: "Sign in" })).toHaveAttribute(
    "href",
    "/signin?next=%2F",
  );
  await header.getByRole("link", { name: "Sign in" }).click();

  const dialog = page.getByRole("dialog", { name: "Sign in to aion.ly" });
  await expect(dialog.getByRole("button", { name: "Continue with Google" })).toBeVisible();
  await expect(dialog).toContainText("stay private");
});

test.describe("without scripts", () => {
  test.use({ javaScriptEnabled: false });

  test("Sign in leads to a sign-in page that still works", async ({ page }) => {
    await page.goto("/u/quiet_otter_482");
    await page.locator("header").getByRole("link", { name: "Sign in" }).click();
    await expect(page).toHaveURL(/\/signin\?next=%2Fu%2Fquiet_otter_482$/);

    // The form posts and the browser heads for Google.
    const leaving = page.waitForRequest((request) =>
      request.url().startsWith("https://accounts.google.com/"),
    );
    await page.getByRole("button", { name: "Continue with Google" }).click();
    expect(new URL((await leaving).url()).searchParams.get("client_id")).toBeTruthy();
  });
});

test("Continue with Google leaves for Google with a callback to this site", async ({ page, baseURL }) => {
  const response = await page.request.post("/signin", {
    form: { next: "/u/quiet_otter_482" },
    headers: { Origin: baseURL! },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(302);
  const location = new URL(response.headers().location);
  expect(location.origin).toBe("https://accounts.google.com");
  expect(location.searchParams.get("redirect_uri")).toBe(
    `${baseURL}/api/auth/callback/google`,
  );
  expect(location.searchParams.get("prompt")).toBe("select_account");
  // The state that ties the callback to this browser is set as a cookie.
  expect(response.headers()["set-cookie"]).toMatch(/better-auth\.state=/);
});

test("sign-in from another site is refused", async ({ page }) => {
  const response = await page.request.post("/signin", {
    form: { next: "/" },
    headers: { Origin: "https://attacker.example" },
    maxRedirects: 0,
  });
  expect(response.status()).toBe(403);
});

test.describe("inside an app's browser", () => {
  test.use({
    userAgent:
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 Instagram 350.0",
  });

  test("sign-in offers the link and the draft to copy", async ({ page }) => {
    await page.goto("/");
    await page.evaluate(() =>
      window.localStorage.setItem("draft:submit", JSON.stringify({ title: "My draft title" })),
    );
    await open(page, "/");
    await page.locator("header").getByRole("link", { name: "Sign in" }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toContainText("does not work inside Instagram");
    await expect(dialog.getByRole("button", { name: "Copy link" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Copy draft" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Continue with Google" })).toHaveCount(0);
  });
});

test("signed in, the top bar holds saved posts, the digest, and the account menu", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/");
  const header = page.locator("header");
  await expect(header.getByRole("link", { name: "Saved posts" })).toBeVisible();
  await expect(header.getByRole("button", { name: /^Email digest/ })).toBeVisible();
  await header.getByRole("button", { name: `Account: ${account.username}` }).click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  await expect(header.getByRole("link", { name: "Sign in" })).toHaveCount(0);
});

test("signing out ends the session", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/");
  await page.getByRole("button", { name: `Account: ${account.username}` }).click();
  await page.getByRole("menuitem", { name: "Sign out" }).click();
  await expect(page.locator("header").getByRole("link", { name: "Sign in" })).toBeVisible();

  // The old cookie no longer works: the session is gone from the database.
  await account.signIn(context);
  await page.reload();
  await expect(page.locator("header").getByRole("link", { name: "Sign in" })).toBeVisible();
});

test("pages for members send a signed-out visitor to sign in, and back", async ({ page }) => {
  await page.goto("/settings");
  await expect(page).toHaveURL(/\/signin\?next=%2Fsettings$/);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  await expect(page.locator('input[name="next"]')).toHaveValue("/settings");
});

test("the welcome step shows the name, and the first change is free", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/welcome?next=%2Fu%2Fquiet_otter_482");
  await expect(page.getByRole("heading", { name: "This is how you'll appear" })).toBeVisible();

  const field = page.getByLabel("Username");
  await expect(field).toHaveValue(account.username);
  await field.fill("Bad Name!");
  await expect(page.getByText("Use lowercase letters")).toBeVisible();
  await expect(page.getByRole("button", { name: "Continue" })).toBeDisabled();

  const fresh = `w_${account.id}`;
  await field.fill(fresh);
  await page.getByRole("button", { name: "Continue" }).click();
  await expect(page).toHaveURL(/\/u\/quiet_otter_482$/);
  await expect(page.getByRole("button", { name: `Account: ${fresh}` })).toBeVisible();

  // The old name now leads to the new one.
  await page.goto(`/u/${account.username}`);
  await expect(page).toHaveURL(new RegExp(`/u/${fresh}$`));
});

test("after the first change, the next waits 30 days", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/settings");
  await page.getByLabel("Username").fill(`s_${account.id}`);
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByRole("status").filter({ hasText: `Your name is now s_${account.id}` })).toBeVisible();

  await expect(page.getByLabel("Username")).toBeDisabled();
  await expect(page.getByText(/You can change it again on \d+ \w+ \d{4}\./)).toBeVisible();
});

test("a taken name is refused", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/settings");
  await page.getByLabel("Username").fill("quiet_otter_482");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("That name is taken")).toBeVisible();
  // A name used before, even by someone who has moved on, stays taken.
  await page.getByLabel("Username").fill("old_otter_name");
  await page.getByRole("button", { name: "Save name" }).click();
  await expect(page.getByText("That name is taken")).toBeVisible();
});

test("a banned account reads, sees why, and cannot change its name", async ({ page, context, bannedAccount, baseURL }) => {
  await bannedAccount.signIn(context);
  await page.goto("/settings");
  await expect(page.getByRole("alert").filter({ hasText: "read-only for good" })).toContainText(
    "Testing the read-only notice",
  );
  await expect(page.getByLabel("Username")).toBeDisabled();

  const response = await page.request.post("/settings", {
    form: { username: "banned_rename" },
    headers: { Origin: baseURL! },
  });
  expect(response.status()).toBe(403);
});

test("without a Google photo, the letter avatar stays and the switch says why", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/settings");
  await expect(page.getByText("Your Google account has no photo to use.")).toBeVisible();
  await expect(page.getByRole("button", { name: "Use my Google photo" })).toBeDisabled();
});

test("the email shows only in the account's own Settings, and the Google name nowhere", async ({ page, context, account, request }) => {
  // The test accounts carry these as their Google identity.
  const email = `${account.id}@example.invalid`;
  const name = `Test ${account.id}`;
  const pages = ["/", "/saved", "/submit", "/welcome", `/u/${account.username}`, "/p/s_post_01"];

  await account.signIn(context);
  await open(page, "/settings");
  const accountSection = page.getByRole("region", { name: "Account", exact: true });
  await expect(accountSection.getByRole("definition").first()).toHaveText(email);
  await expect(accountSection.getByRole("button", { name: "Change" })).toHaveCount(0);
  expect(await (await page.request.get("/settings")).text()).not.toContain(name);

  for (const path of pages) {
    const body = await (await page.request.get(path)).text();
    for (const secret of [email, name]) expect(body, `${secret} on ${path}`).not.toContain(secret);
  }
  const anonymous = await request.get(`/u/${account.username}`);
  for (const secret of [email, name]) expect(await anonymous.text()).not.toContain(secret);
});

test("a refused Google sign-in says why", async ({ page }) => {
  await page.goto("/signin?error=email_not_verified");
  await expect(page.getByText("Google has not verified this account's email.")).toBeVisible();
  await page.goto("/signin?error=account_not_linked");
  await expect(page.getByText("That email already belongs to an account here")).toBeVisible();
});
