import type { Page } from "@playwright/test";

import { expect, open, test, type TestAccount } from "./fixtures";

// Links on subdomains that do not exist: the server's preview fetch fails at
// once, as a dead page would, and no test traffic reaches a real site.
const linkFor = (account: TestAccount, path = "tool") =>
  `https://e2e-${account.id.toLowerCase()}.example.com/${path}`;

async function checkLink(page: Page, url: string): Promise<void> {
  await page.getByLabel("Link").fill(url);
  await page.getByRole("button", { name: "Check link" }).click();
  await expect(page.getByRole("button", { name: "Checked" })).toBeVisible();
}

async function fillPost(page: Page, title: string): Promise<void> {
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("A small tool for testing how posts are published.");
  await page.getByLabel("I found this").check();
  await page.getByLabel(/made with AI or about AI/).check();
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
}

test("signed out, Submit leads to sign-in and back", async ({ page }) => {
  await open(page, "/");
  await page.locator("header").getByRole("link", { name: "Submit a post" }).click();
  await expect(page).toHaveURL(/\/signin\?next=%2Fsubmit$/);
});

test("a link is checked, previewed, published, and then the day's allowance shows", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();

  const url = linkFor(account);
  await checkLink(page, `${url}?utm_source=newsletter#top`);
  await expect(page.getByText("How it will appear")).toBeVisible();
  await expect(page.locator("a", { hasText: `e2e-${account.id.toLowerCase()}.example.com` })).toBeVisible();

  const title = `E2E post: published by ${account.username}`;
  await fillPost(page, title);
  await page.getByRole("button", { name: "Publish" }).click();

  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/[0-9a-z-]+$/);
  const card = page.locator("article").first();
  await expect(card.locator("h2")).toContainText(title);
  // The stored link has no tracking and no fragment.
  await expect(card.locator("h2 a")).toHaveAttribute("href", url);
  await expect(card).toContainText("Discovery");

  await open(page, "/submit");
  await expect(page.getByRole("status").filter({ hasText: /Next post available in 2[34] h/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();

  // The draft was cleared on publishing.
  await expect(page.getByLabel("Title")).toHaveValue("");
});

test("an already posted link points to the post instead", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByLabel("Link").fill("https://youtu.be/aqz-KE-bpKQ?si=share");
  await page.getByRole("button", { name: "Check link" }).click();
  const notice = page.getByRole("status").filter({ hasText: "Already posted." });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "See the post" })).toHaveAttribute("href", "/p/s_post_01");
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
});

test("a link that cannot be posted says why", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByLabel("Link").fill("http://example.com/plain");
  await page.getByRole("button", { name: "Check link" }).click();
  await expect(page.getByText("Only https links can be posted.")).toBeVisible();
});

test("the form keeps its draft through a reload", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await checkLink(page, linkFor(account, "draft"));
  await page.getByLabel("Title").fill("A draft that survives");
  await page.getByLabel("Description").fill("Typed before the page was reloaded.");
  await page.getByLabel("I made this").check();

  await open(page, "/submit");
  await expect(page.getByLabel("Link")).toHaveValue(linkFor(account, "draft"));
  await expect(page.getByLabel("Title")).toHaveValue("A draft that survives");
  await expect(page.getByLabel("Description")).toHaveValue("Typed before the page was reloaded.");
  await expect(page.getByLabel("I made this")).toBeChecked();
  // The check came back with it.
  await expect(page.getByRole("button", { name: "Checked" })).toBeVisible();
});

test("fields are checked as they are typed and again on publishing", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await checkLink(page, linkFor(account, "fields"));
  await page.getByLabel("Title").fill("ab");
  await page.getByLabel("Description").fill("Too short.");
  await page.getByLabel("Title").focus();
  await expect(page.getByText("Write a title of at least 3 characters.")).toBeVisible();
  await expect(page.getByText("Write at least 20 characters.")).toBeVisible();

  // Without the origin and the attestation, the server answers under each.
  await page.getByLabel("Title").fill("A proper title");
  await page.getByLabel("Description").fill("Now the description is long enough.");
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page.getByText("Say whether you made it or found it.")).toBeVisible();
  await expect(page.getByText("Confirm the post fits the board.")).toBeVisible();
  await expect(page).toHaveURL(/\/submit$/);
});

test("text posts and uploads are shown as coming, and cannot be published", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  for (const [source, text] of [
    ["Text", "Write a text post"],
    ["Upload", "Upload a picture, video, or audio"],
  ] as const) {
    await page.getByRole("button", { name: source, exact: true }).click();
    await expect(page.getByText(text)).toBeVisible();
    await expect(page.getByText("Soon")).toBeVisible();
    await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
  }
});

test("a banned account sees why it cannot post", async ({ page, context, bannedAccount }) => {
  await bannedAccount.signIn(context);
  await open(page, "/submit");
  await expect(page.getByRole("alert").filter({ hasText: "read-only while the ban lasts" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
});

test("publishing needs a receipt from Check link, and refuses other sites", async ({ page, context, account, baseURL }) => {
  await account.signIn(context);
  await page.goto("/");
  const form = {
    receipt: "forged.receipt",
    title: "A forged post",
    description: "Trying to skip the Check link step.",
    origin: "found",
    attest: "yes",
    "cf-turnstile-response": "XXXX.DUMMY.TOKEN.XXXX",
  };
  const forged = await page.request.post("/submit", { form, headers: { Origin: baseURL! } });
  expect(await forged.text()).toContain("Check the link before publishing.");
  const crossSite = await page.request.post("/submit", { form, headers: { Origin: "https://evil.example" } });
  expect(crossSite.status()).toBe(403);
});
