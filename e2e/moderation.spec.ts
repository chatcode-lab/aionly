import type { Browser, Page } from "@playwright/test";

import { expect, open, test, type TestAccount } from "./fixtures";

const POST = "/p/s_post_15";

/** A page signed in as an account, in a context of its own. */
async function as(browser: Browser, account: TestAccount): Promise<Page> {
  const context = await browser.newContext();
  await account.signIn(context);
  return context.newPage();
}

async function comment(page: Page, text: string): Promise<string> {
  await open(page, POST);
  await page.getByLabel("Comment", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const item = page.locator("li[id^='c-']", { has: page.getByText(text, { exact: true }) });
  await expect(item).toBeVisible();
  return (await item.getAttribute("id"))!;
}

test("signed out, Report leads to sign-in", async ({ page }) => {
  await open(page, POST);
  await page.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await page.getByRole("menuitem", { name: "Report" }).click();
  await expect(page.getByRole("dialog", { name: "Sign in to report" })).toBeVisible();
});

test("a report reaches the queue, and removing the comment there closes it", async ({ browser, page, context, account, otherAccount, adminAccount }, testInfo) => {
  const text = `Reported comment by ${otherAccount.username} in ${testInfo.project.name}`;
  const author = await as(browser, otherAccount);
  const id = await comment(author, text);

  await account.signIn(context);
  await open(page, POST);
  const item = page.locator(`li#${id}`);
  await item.getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Report" }).click();
  const dialog = page.getByRole("dialog", { name: "Report comment" });
  await dialog.getByLabel("Spam or advertising").check();
  await dialog.getByLabel("Anything to add?").fill(`Spam seen by ${account.username}`);
  await dialog.getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("Report sent. A moderator will look at it.").first()).toBeVisible();

  // Reporting again finds the open report.
  await item.getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Report" }).click();
  await page.getByRole("dialog", { name: "Report comment" }).getByRole("button", { name: "Send report" }).click();
  await expect(page.getByText("You reported this already").first()).toBeVisible();

  const admin = await as(browser, adminAccount);
  await open(admin, "/admin");
  const card = admin.locator("article", { hasText: `Spam seen by ${account.username}` });
  await expect(card).toContainText("Spam or advertising");
  await expect(card).toContainText(`by ${otherAccount.username}`);
  await card.getByText("What was reported").click();
  await expect(card).toContainText(text);
  await card.getByRole("button", { name: "Remove comment" }).click();
  await expect(card).toHaveCount(0);

  await open(admin, POST);
  const removed = admin.locator(`li#${id}`);
  await expect(removed).toContainText("[removed by moderator]");
  await expect(removed).not.toContainText(text);
  await removed.getByRole("button", { name: "Restore" }).click();
  await expect(admin.locator(`li#${id}`)).toContainText(text);
});

test("an admin removes a comment from its menu, and Undo brings it back", async ({ browser, otherAccount, adminAccount }, testInfo) => {
  const text = `To be removed, by ${otherAccount.username} in ${testInfo.project.name}`;
  const id = await comment(await as(browser, otherAccount), text);

  const admin = await as(browser, adminAccount);
  await open(admin, POST);
  const item = admin.locator(`li#${id}`);
  await item.getByRole("button", { name: "Comment actions" }).first().click();
  await admin.getByRole("menuitem", { name: "Remove comment" }).click();
  await expect(item).toContainText("[removed by moderator]");
  await admin.getByRole("button", { name: "Undo" }).click();
  await expect(item).toContainText(text);
});

test("a ban makes an account read-only, with its comments removed, and both can be undone", async ({ browser, otherAccount, adminAccount }, testInfo) => {
  const text = `Before the ban, by ${otherAccount.username} in ${testInfo.project.name}`;
  const author = await as(browser, otherAccount);
  const id = await comment(author, text);

  const admin = await as(browser, adminAccount);
  await open(admin, `/u/${otherAccount.username}`);
  await admin.getByRole("button", { name: "Profile actions" }).click();
  await admin.getByRole("menuitem", { name: `Ban ${otherAccount.username}` }).click();
  const dialog = admin.getByRole("dialog", { name: `Ban ${otherAccount.username}?` });
  await expect(dialog).toContainText("1 comment.");
  await dialog.getByLabel("1 day").check();
  await dialog.getByLabel("Reason").fill("Testing timed bans");
  await dialog.getByLabel(/Remove all their comments/).check();
  await dialog.getByRole("button", { name: "Ban user" }).click();
  await expect(admin.getByText(`${otherAccount.username} is banned.`).first()).toBeVisible();

  await author.reload();
  await expect(author.getByRole("alert").filter({ hasText: "read-only until" })).toContainText("Testing timed bans");
  await expect(author.locator(`li#${id}`)).toContainText("[removed by moderator]");
  await expect(author.getByText("Commenting is paused while your account is read-only.")).toBeVisible();

  // The log restores the comments; the profile menu lifts the ban.
  await open(admin, "/admin/log");
  const entry = admin.locator("li", { hasText: `removed all comments by ${otherAccount.username}` });
  await entry.getByRole("button", { name: "Restore comments" }).click();
  await expect(admin.locator("li", { hasText: `removed all comments by ${otherAccount.username}` }).first()).toContainText("undone");
  await open(admin, `/u/${otherAccount.username}`);
  await admin.getByRole("button", { name: "Profile actions" }).click();
  await admin.getByRole("menuitem", { name: `Unban ${otherAccount.username}` }).click();
  await expect(admin.getByText(`${otherAccount.username} is unbanned.`).first()).toBeVisible();

  await author.reload();
  await expect(author.getByRole("alert").filter({ hasText: "read-only" })).toHaveCount(0);
  await expect(author.locator(`li#${id}`)).toContainText(text);
});

test("moderation is invisible to everyone but admins", async ({ page, context, account, baseURL }) => {
  expect((await page.request.get("/admin")).status()).toBe(404);
  await account.signIn(context);
  expect((await page.request.get("/admin")).status()).toBe(404);
  expect((await page.request.get("/admin/log")).status()).toBe(404);
  const response = await page.request.post("/api/moderate", {
    data: { action: "remove_post", id: "s_post_15" },
    headers: { Origin: baseURL! },
  });
  expect(response.status()).toBe(404);

  await open(page, POST);
  await page.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Report" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: "Remove post" })).toHaveCount(0);
  await expect(page.getByRole("menuitem", { name: /Ban / })).toHaveCount(0);
});

test("an admin pins an announcement above the feed; readers can collapse it", async ({ browser, page, context, account, adminAccount }, testInfo) => {
  // One pin slot for the whole board: only one project runs this.
  test.skip(testInfo.project.name !== "submit-desktop", "the pin is shared by every test");
  const admin = await as(browser, adminAccount);
  await open(admin, "/p/s_post_13");
  await admin.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await admin.getByRole("menuitem", { name: "Pin as announcement" }).click();
  await expect(admin.getByText("Pinned above the feed as the announcement.").first()).toBeVisible();

  await account.signIn(context);
  await open(page, "/?range=all");
  const pinned = page.getByRole("region", { name: "Announcement" });
  await expect(pinned).toContainText("Me at the zoo");
  // Not repeated in the feed below.
  await expect(page.locator("article", { hasText: "Me at the zoo" })).toHaveCount(1);
  await pinned.getByRole("button", { name: "Collapse announcement" }).click();
  await page.reload();
  await expect(page.getByRole("button", { name: /Announcement.*Me at the zoo/ })).toHaveAttribute("aria-expanded", "false");

  await open(admin, "/p/s_post_13");
  await admin.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await admin.getByRole("menuitem", { name: "Unpin" }).click();
  await expect(admin.getByText("Unpinned.", { exact: true }).first()).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: /Announcement/ })).toHaveCount(0);
});

test("an admin pins a comment to the top of a discussion, and takes it down", async ({ browser, otherAccount, adminAccount }, testInfo) => {
  // Two signed-in browsers and several page loads.
  test.slow();
  // A post of each project's own, so runs side by side do not pin over each other; seeding resets it.
  const post = testInfo.project.name.includes("narrow") ? "/p/s_post_11" : "/p/s_post_10";
  const text = `Worth pinning, by ${otherAccount.username} in ${testInfo.project.name}`;
  const writer = await as(browser, otherAccount);
  await open(writer, post);
  await writer.getByLabel("Comment", { exact: true }).fill(text);
  await writer.getByRole("button", { name: "Comment", exact: true }).click({ timeout: 10_000 });
  // In the thread, not just still in the box: only then does the admin's page load it.
  await expect(writer.locator("li[id^='c-']", { has: writer.getByText(text, { exact: true }) })).toBeVisible();

  const admin = await as(browser, adminAccount);
  await open(admin, post);
  const item = admin.locator("li[id^='c-']", { has: admin.getByText(text, { exact: true }) });
  const actions = item.getByRole("button", { name: "Comment actions" }).first();
  await actions.click({ timeout: 10_000 });
  await admin.getByRole("menuitem", { name: "Pin to the top" }).click({ timeout: 10_000 });
  await expect(admin.getByText("Pinned to the top of the discussion.", { exact: true })).toBeVisible();
  // First in the thread, marked, in any order.
  const first = admin.locator("section[aria-labelledby=comments-heading] ul > li").first();
  await expect(first).toContainText(text);
  await expect(first.getByText("Pinned", { exact: true })).toHaveAttribute("title", "Pinned by a moderator");
  await open(admin, `${post}?order=new`);
  await expect(admin.locator("section[aria-labelledby=comments-heading] ul > li").first()).toContainText(text);
  // The writer sees it too.
  await open(writer, post);
  await expect(writer.locator("section[aria-labelledby=comments-heading] ul > li").first()).toContainText(text);

  await open(admin, post);
  await actions.click({ timeout: 10_000 });
  await admin.getByRole("menuitem", { name: "Unpin" }).click({ timeout: 10_000 });
  await expect(admin.getByText("Unpinned.", { exact: true })).toBeVisible();
});

test("an admin tunes the board's numbers, checked before saving and logged", async ({ browser, account, adminAccount }, testInfo) => {
  // The setting is one for the whole board, so one project changes it; two
  // at once would each see the other's value (F64).
  test.skip(testInfo.project.name !== "submit-desktop", "Changes a board-wide setting; runs in one project.");
  const member = await as(browser, account);
  const refused = await member.goto("/admin/settings");
  expect(refused?.status()).toBe(404);

  const admin = await as(browser, adminAccount);
  try {
    await open(admin, "/admin/settings");
    await expect(admin.getByRole("navigation", { name: "Moderation" }).getByRole("link", { name: "Settings" })).toHaveAttribute("aria-current", "page");
    for (const group of ["Karma", "Invitations", "Limits", "Discussions"]) {
      await expect(admin.getByRole("heading", { name: group, level: 2 })).toBeVisible();
    }
    const field = admin.getByLabel("Reports a day");
    await expect(admin.getByLabel("Karma floor (karma)")).toHaveValue(/^-\d+$/);

    // Nothing is saved while any value is wrong.
    await field.fill("many");
    await admin.getByRole("button", { name: "Save changes" }).click();
    await expect(admin.getByText("Nothing was saved. Fix the marked values, then save again.")).toBeVisible();
    await expect(admin.getByText("A whole number.")).toBeVisible();
    await expect(field).toHaveValue("many");

    await field.fill("21");
    await admin.getByRole("button", { name: "Save changes" }).click();
    await expect(admin.getByText("Saved: Reports a day.")).toBeVisible();
    await expect(field).toHaveValue("21");
    await expect(admin.getByRole("region", { name: "Recent changes" })).toContainText(`changed reports a day:`);
    await expect(admin.getByRole("region", { name: "Recent changes" })).toContainText("→ 21");
    await open(admin, "/admin/log");
    await expect(admin.getByText("changed the setting").first()).toBeVisible();
  } finally {
    // The default back, whatever happened above.
    await open(admin, "/admin/settings");
    await admin.getByLabel("Reports a day").fill("20");
    await admin.getByRole("button", { name: "Save changes" }).click();
    await expect(admin.getByText(/Saved: Reports a day\.|Nothing changed\./)).toBeVisible();
  }
});

test("an admin makes a partner link, which signs people up and shows in the partner's Settings", async ({ browser, page, account, adminAccount }, testInfo) => {
  test.skip(testInfo.project.name !== "submit-desktop", "Makes a board-wide link; runs in one project.");
  const code = `p-${account.id.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-12)}`;
  const admin = await as(browser, adminAccount);
  await open(admin, "/admin/partners");
  await admin.getByLabel("Partner's username").fill(account.username);
  await admin.getByLabel("Link name").fill(code);
  await admin.getByRole("button", { name: "Make the link" }).click();
  await expect(admin.getByText(`Made /join/${code}.`)).toBeVisible();
  await expect(admin.getByText(`/join/${code} · ${account.username}`)).toBeVisible();

  // Signed out, the link names the partner and keeps itself for the sign-up.
  await open(page, `/join/${code}`);
  await expect(page.getByRole("heading", { name: `${account.username} invites you to aion.ly` })).toBeVisible();
  expect((await page.context().cookies()).find((cookie) => cookie.name === "aionly_partner")?.value).toBe(code);

  const partner = await as(browser, account);
  await open(partner, "/settings#partner");
  const section = partner.getByRole("region", { name: "Your partner link" });
  await expect(section).toContainText(`/join/${code}`);
  await expect(section).toContainText("0 joined");
  await expect(section).toContainText("Earned $0");

  await open(admin, "/admin/partners");
  await admin.locator("li", { hasText: `/join/${code} ·` }).getByRole("button", { name: "Revoke" }).click();
  await expect(admin.getByText("The link no longer takes sign-ups.")).toBeVisible();
  await page.context().clearCookies();
  await open(page, `/join/${code}`);
  await expect(page.getByText("This link no longer works.")).toBeVisible();
});

test("an admin names a guest editor, whose pick and focus show above the feed", async ({ browser, page, account, adminAccount }, testInfo) => {
  test.skip(testInfo.project.name !== "submit-desktop", "One editor at a time for the whole board; runs in one project.");
  const admin = await as(browser, adminAccount);
  const editor = await as(browser, account);
  await open(admin, "/admin/editors");
  await admin.getByLabel("Member's username").fill(account.username);
  await admin.getByLabel("Days").fill("1");
  await admin.getByRole("button", { name: "Name the editor" }).click();
  await expect(admin.getByText(new RegExp(`^${account.username} edits from `))).toBeVisible();
  try {
    await open(editor, "/settings#editor");
    const tools = editor.getByRole("region", { name: "Guest editor" });
    await tools.getByLabel("This term's focus").fill("Agents that ship real work");
    await tools.getByRole("button", { name: "Save the focus" }).click();
    await expect(tools.getByText("Saved.")).toBeVisible();

    await open(editor, "/p/s_post_14");
    await editor.locator("article").first().getByRole("button", { name: "Post actions" }).click();
    await editor.getByRole("menuitem", { name: "Pick as editor" }).click();
    const dialog = editor.getByRole("dialog", { name: "Pick this post?" });
    await dialog.getByLabel("Why it matters, in a line").fill("Worth a look");
    await dialog.getByRole("button", { name: "Pick it" }).click();
    await expect(editor.getByText("Picked and pinned above the feed.").first()).toBeVisible();

    await open(page, "/?range=all");
    await expect(page.getByText(`Guest editor ${account.username}`)).toBeVisible();
    await expect(page.getByText("Agents that ship real work")).toBeVisible();
    const pick = page.getByRole("region", { name: "Editor's pick" });
    await expect(pick).toContainText("Worth a look");
    await expect(pick.getByText("Editor's pick").last()).toBeVisible();

    // Taken back: the mark goes, and the pin with it.
    await open(editor, "/p/s_post_14");
    await editor.locator("article").first().getByRole("button", { name: "Post actions" }).click();
    await editor.getByRole("menuitem", { name: "Take back the pick" }).click();
    await expect(editor.getByText("Pick taken back.").first()).toBeVisible();
    await page.reload();
    await expect(page.getByRole("region", { name: "Editor's pick" })).toHaveCount(0);
  } finally {
    await open(admin, "/admin/editors");
    const running = admin.locator("li", { hasText: `${account.username},` }).getByRole("button", { name: "End now" });
    if (await running.count()) {
      await running.click();
      await expect(admin.getByText("The term is over.")).toBeVisible();
    }
  }
  await page.reload();
  await expect(page.getByText(`Guest editor ${account.username}`)).toHaveCount(0);
});

test("an admin names the fund's cause and records a gift, which the fund's page lists", async ({ browser, page, adminAccount }, testInfo) => {
  test.skip(testInfo.project.name !== "submit-desktop", "The fund is the whole board's; runs in one project.");
  const admin = await as(browser, adminAccount);
  await open(admin, "/admin/fund");
  await admin.getByLabel("Cause", { exact: true }).fill("Open Source Example Fund");
  await admin.getByLabel("Its address").fill("https://cause.example.org/");
  await admin.getByRole("button", { name: "Name the cause" }).click();
  await expect(admin.getByText("The next gift goes to Open Source Example Fund.")).toBeVisible();

  await admin.getByLabel("Given on").fill("2026-10-31");
  await admin.getByLabel("Amount, USD").fill("18.50");
  await admin.getByRole("button", { name: "Record the gift" }).click();
  await expect(admin.getByText("Recorded $18.50 to Open Source Example Fund.")).toBeVisible();

  await open(page, "/fund");
  await expect(page.getByRole("link", { name: "Open Source Example Fund" }).first()).toHaveAttribute("href", "https://cause.example.org/");
  await expect(page.getByText("$18.50").first()).toBeVisible();

  await open(admin, "/admin/fund");
  await admin.locator("li", { hasText: "2026-10-31: $18.50" }).getByRole("button", { name: "Remove" }).click();
  await expect(admin.getByText("Removed the gift.")).toBeVisible();
});
