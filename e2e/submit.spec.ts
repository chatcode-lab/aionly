import type { Page } from "@playwright/test";

import { expect, open, test, type TestAccount } from "./fixtures";
import { localDb } from "./support/local-db";

// Links on subdomains that do not exist: the server's preview fetch fails at
// once, as a dead page would, and no test traffic reaches a real site.
const linkFor = (account: TestAccount, path = "tool") =>
  `https://e2e-${account.id.toLowerCase()}.example.com/${path}`;

async function checkLink(page: Page, url: string): Promise<void> {
  await page.getByLabel("Link", { exact: true }).fill(url);
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
  // The allowance in force comes first, so the next tier never reads as the limit.
  await expect(page.getByRole("status").filter({ hasText: /^You can post once a day at your karma\. Next post available in 2[34] h\. Your draft is saved\. From 50 karma, twice a day\.$/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();

  // The draft was cleared on publishing.
  await expect(page.getByLabel("Title")).toHaveValue("");
});

test("a saved draft opens checked from its preview, and one whose picture went meanwhile is checked again (review F108, F110)", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  const url = linkFor(account, "previewed");
  await page.getByLabel("Link", { exact: true }).fill(url);
  await page.getByLabel("Title").fill("A previewed page");
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect(page.getByText("Draft saved.")).toBeVisible();
  const draftId = new URL(page.url()).searchParams.get("draft")!;

  // Once its own preview of this unreachable page is in, it is given one a
  // reachable page's would be: a title and a picture, kept with the draft.
  const db = localDb();
  const previewed = () => (db.prepare(`SELECT preview IS NOT NULL AS done FROM drafts WHERE id = ?`).get(draftId) as { done: number }).done;
  await expect.poll(previewed).toBe(1);
  const picture = `${draftId}${"x".repeat(24)}`.slice(0, 24) + ".png";
  db.prepare(`INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at) VALUES (?, ?, 'post', 'draft', 'image/png', 68, unixepoch())`).run(picture, account.id);
  const host = new URL(url).host;
  const preview = { for: url, url, host, provider: null, aspect: null, pageTitle: "The page's own title", duplicate: null };
  db.prepare(`UPDATE drafts SET preview = ?, preview_thumb_key = ? WHERE id = ?`).run(JSON.stringify(preview), picture, draftId);

  // Opened again, it is checked from what was stored, with no new check.
  await open(page, `/submit?draft=${draftId}`);
  await expect(page.getByRole("button", { name: "Checked" })).toBeDisabled();
  await expect(page.getByText("The page's own title")).toBeVisible();

  // Its picture goes before it is published, as when a newer preview replaces it.
  db.prepare(`DELETE FROM images WHERE key = ?`).run(picture);
  db.close();
  await fillPost(page, "A previewed page");
  await page.getByRole("button", { name: "Publish" }).click();
  const stale = page.getByText(/The link's picture was replaced meanwhile/);
  await expect(stale).toBeVisible();
  // Check link works again, its word replaces the refusal's, and it publishes.
  await page.getByRole("button", { name: "Check link" }).click();
  await expect(page.getByRole("button", { name: "Checked" })).toBeVisible();
  await expect(stale).toHaveCount(0);
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/[0-9a-z-]+$/);
});

test("an already posted link points to the post instead", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  // Someone's own work from two weeks ago.
  await page.getByLabel("Link", { exact: true }).fill("https://example.com/gallery?utm_source=share");
  await page.getByRole("button", { name: "Check link" }).click();
  const notice = page.getByRole("status").filter({ hasText: "Already posted." });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "See the post" })).toHaveAttribute("href", "/p/s_post_14");
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();
});

test("a discovery posted again as one is refused with no hint, and its maker may post it", async ({ page, context, account, otherAccount }) => {
  // Someone shares the link first, as a discovery.
  const link = linkFor(account, "shared-work");
  await account.signIn(context);
  await open(page, "/submit");
  await checkLink(page, link);
  await fillPost(page, `E2E discovery by ${account.username}`);
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/e2e-discovery-by-/);
  const first = new URL(page.url()).pathname.split("/")[2];

  // Someone else, in the same browser, finds it passes the check...
  await otherAccount.signIn(context);
  await open(page, "/submit");
  await checkLink(page, link);
  await fillPost(page, `E2E repost by ${otherAccount.username}`);
  await page.getByRole("button", { name: "Publish" }).click();
  // ...and refused on publishing it as a discovery, saying nothing of making it.
  const notice = page.getByRole("status").filter({ hasText: "Already posted." });
  await expect(notice).toBeVisible();
  await expect(notice.getByRole("link", { name: "See the post" })).toHaveAttribute("href", `/p/${first}`);
  await expect(notice).not.toContainText(/made|own work|creator/i);
  await expect(page.getByRole("button", { name: "Publish" })).toBeDisabled();

  // As its maker, saying so, they post it as their own work; the draft and its check come back.
  await open(page, "/submit");
  await expect(page.getByRole("button", { name: "Checked" })).toBeVisible();
  await page.getByLabel("I made this").check();
  await page.getByLabel(/made with AI or about AI/).check();
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/e2e-repost-by-/);
  await expect(page.locator("article").first()).toContainText("Original");
});

test("a link that cannot be posted says why", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByLabel("Link", { exact: true }).fill("http://example.com/plain");
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
  await expect(page.getByLabel("Link", { exact: true })).toHaveValue(linkFor(account, "draft"));
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

test("text posts and uploads show the plan to a member without it, and cannot be published", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  for (const [source, feature, title] of [
    ["Text", "text", "Text posts are for fans"],
    ["Upload", "upload", "Uploads are for fans"],
  ] as const) {
    await page.getByRole("button", { name: source, exact: true }).click();
    const paywall = page.locator(`[data-paywall=${feature}]`);
    await expect(paywall.getByRole("heading", { name: title })).toBeVisible();
    // What else the plan adds, with this feature picked out.
    await expect(paywall.locator("[data-highlight]")).toHaveCount(1);
    await expect(paywall).toContainText("An agent of your own");
    await expect(paywall.getByRole("link", { name: "Become a fan" })).toHaveAttribute("href", `/fan?for=${feature}`);
    await expect(page.getByRole("button", { name: "Publish" })).toBeHidden();
  }
});

test("an agent that says it is one is shown how agents post, and a misclick goes back", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await page.getByLabel("Title").fill("A draft that must survive");
  await page.getByRole("checkbox", { name: "I'm an AI agent acting on this member's behalf." }).check();
  const paywall = page.locator("[data-paywall=agent]");
  await expect(paywall.getByRole("heading", { name: "Agents post under their own name" })).toBeVisible();
  await expect(paywall).toContainText("nothing was posted");
  await expect(page.getByRole("button", { name: "Publish" })).toBeHidden();

  await paywall.getByRole("button", { name: "I misclicked" }).click();
  await expect(page.getByLabel("Title")).toHaveValue("A draft that must survive");
  await expect(page.getByRole("checkbox", { name: "I'm an AI agent acting on this member's behalf." })).not.toBeChecked();
});

test("the human check takes its compact size where the full one would not fit", async ({ page, context, account, viewport }) => {
  await account.signIn(context);
  await open(page, "/submit");
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  const size = await page.evaluate(() => (window as unknown as { turnstileOptions?: { size?: string } }).turnstileOptions?.size);
  expect(size).toBe(viewport!.width < 340 ? "compact" : "flexible");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
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
