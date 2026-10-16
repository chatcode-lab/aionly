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
  await expect(header.getByRole("link", { name: "Saved", exact: true })).toBeVisible();
  await expect(header.getByRole("button", { name: /^Email digest/ })).toBeVisible();
  await header.getByRole("button", { name: `Account: ${account.username}` }).click();
  await expect(page.getByRole("menuitem", { name: "Settings" })).toBeVisible();
  // The theme and autoplay are in Settings, not the menu.
  await expect(page.getByRole("menuitemradio")).toHaveCount(0);
  await expect(header.getByRole("link", { name: "Sign in" })).toHaveCount(0);
});

test("signed in, the theme and autoplay are chosen in Settings", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/settings");
  const display = page.getByRole("region", { name: "Display" });
  await expect(display.getByRole("radio", { name: "System" })).toBeChecked();
  const saved = page.waitForResponse((response) => response.request().method() === "POST" && new URL(response.url()).pathname.startsWith("/theme"));
  await display.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  expect((await saved).status()).toBe(200);
  const autoplay = display.getByRole("checkbox", { name: /Autoplay videos/ });
  await expect(autoplay).toBeChecked();
  await autoplay.uncheck();
  await open(page, "/settings");
  await expect(page.getByRole("region", { name: "Display" }).getByRole("radio", { name: "Dark" })).toBeChecked();
  await expect(page.getByRole("region", { name: "Display" }).getByRole("checkbox", { name: /Autoplay videos/ })).not.toBeChecked();
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

test("a member makes an invitation, whose link or typed code greets the invited by name, and can revoke it", async ({ page, context, account, browser }) => {
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Invitations" });
  await section.getByRole("button", { name: "Make an invitation" }).click();
  const shown = section.locator("p.font-mono").first();
  await expect(shown).toHaveText(/^[0-9A-HJKMNP-TV-Z]{8}$/);
  const code = (await shown.textContent())!.trim();
  await expect(section.getByText(`/invite/${code}`)).toBeVisible();
  // Every control of the row sits inside its card.
  const row = section.locator("li").filter({ hasText: code });
  const box = (await row.boundingBox())!;
  for (const name of ["Copy link", "Copy code", "Revoke"]) {
    const button = (await row.getByRole("button", { name }).boundingBox())!;
    expect(button.x + button.width, name).toBeLessThanOrEqual(box.x + box.width);
  }

  // Someone given the code types it, in lower case, where they sign in.
  const visitor = await browser.newContext();
  const guest = await visitor.newPage();
  await open(guest, "/signin");
  await guest.getByLabel(/New here\?/).fill(code.toLowerCase());
  await guest.getByRole("button", { name: "Use code" }).click();
  await expect(guest).toHaveURL(new RegExp(`/invite/${code}$`));
  await expect(guest.getByRole("heading", { name: `${account.username} invited you to aion.ly` })).toBeVisible();
  await expect(guest.getByRole("button", { name: /Continue with Google/ })).toBeVisible();
  expect((await visitor.cookies()).some((cookie) => cookie.name === "aionly_invite" && cookie.value === code)).toBe(true);

  // Revoked, it no longer works, by link or by code.
  await row.getByRole("button", { name: "Revoke" }).click();
  await expect(section.locator("p.font-mono")).toHaveCount(0);
  await guest.goto(`/invite/${code}`);
  await expect(guest.getByText("This invitation was revoked")).toBeVisible();
  await guest.goto(`/invite?code=${code.toLowerCase()}`);
  await expect(guest.getByText("This invitation was revoked")).toBeVisible();
  await visitor.close();
});

test("a sign-in without an invitation says how to join", async ({ page }) => {
  await open(page, "/signin?error=invite_required");
  await expect(page.getByText("Enter the code you were given below, or open the link")).toBeVisible();
  await expect(page.getByLabel(/New here\?/)).toBeVisible();
});
