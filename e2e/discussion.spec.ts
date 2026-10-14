import type { Page } from "@playwright/test";

import { expect, open, test, type TestAccount } from "./fixtures";

// A plain link card, quick to load, whose discussion these tests add to.
const POST = "/p/s_post_15";

function commentItem(page: Page, text: string) {
  return page.locator("li[id^='c-']", { has: page.getByText(text, { exact: true }) }).last();
}

async function addComment(page: Page, text: string): Promise<void> {
  const box = page.getByLabel("Comment", { exact: true });
  await box.fill(text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(commentItem(page, text)).toBeVisible();
}

/** Publishes a post as the account, through the submit form, and opens it. */
async function publish(page: Page, account: TestAccount, title: string): Promise<string> {
  await open(page, "/submit");
  await page.getByLabel("Link").fill(`https://e2e-${account.id.toLowerCase()}.example.com/discussion`);
  await page.getByRole("button", { name: "Check link" }).click();
  await expect(page.getByRole("button", { name: "Checked" })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("A post made to be edited and then deleted by its author.");
  await page.getByLabel("I made this").check();
  await page.getByLabel(/made with AI or about AI/).check();
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9A-Za-z]{12}$/);
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
  return new URL(page.url()).pathname;
}

test("signed out, the discussion opens with a single Sign in to comment row", async ({ page }) => {
  await open(page, POST);
  const row = page.getByRole("link", { name: "Sign in to comment" });
  await expect(row).toHaveAttribute("href", "/signin?next=%2Fp%2Fs_post_15");
  await expect(page.getByLabel("Comment", { exact: true })).toHaveCount(0);
  await row.click();
  await expect(page.getByRole("dialog", { name: "Sign in to comment" })).toBeVisible();
});

test("a comment is added with its formatting, links stay text, and the draft is cleared", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const text = `Formatted by ${account.username} in ${testInfo.project.name}`;
  await page.getByLabel("Comment", { exact: true }).fill(
    `**${text}**\n\nsee [the paper](https://arxiv.org/abs/1706.03762)\n\n- one\n- two`,
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const item = page.locator("li[id^='c-']", { has: page.locator("strong", { hasText: text }) });
  await expect(item).toBeVisible();
  await expect(item.getByText("see the paper (https://arxiv.org/abs/1706.03762)")).toBeVisible();
  await expect(item.locator("a[href*='arxiv']")).toHaveCount(0);
  await expect(item.locator("ul li")).toHaveCount(2);
  await expect(page).toHaveURL(new RegExp(`#c-[0-9A-Za-z]{12}$`));
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("");

  // Own comments take no votes from their author, and carry the author's menu.
  await expect(item.getByRole("button", { name: "Upvote" }).first()).toBeDisabled();
  await expect(item.getByRole("button", { name: "Comment actions" }).first()).toBeVisible();

  await page.reload();
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue("");
});

test("an unsent comment survives a reload", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, POST);
  await page.getByLabel("Comment", { exact: true }).fill(`Half-written by ${account.username}`);
  await page.reload();
  await expect(page.getByLabel("Comment", { exact: true })).toHaveValue(`Half-written by ${account.username}`);
});

test("Reply opens the box under its comment, and the reply nests there", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const parent = `Parent from ${account.username} in ${testInfo.project.name}`;
  await addComment(page, parent);

  const item = commentItem(page, parent);
  await item.getByRole("button", { name: "Reply" }).first().click();
  const box = item.getByLabel("Reply", { exact: true });
  await expect(box).toBeFocused();
  const reply = `Reply from ${account.username} in ${testInfo.project.name}`;
  await box.fill(reply);
  await item.getByRole("button", { name: "Reply", exact: true }).last().click();

  await expect(item.locator("ul li[id^='c-']", { hasText: reply })).toBeVisible();
  await expect(item.getByLabel("Reply", { exact: true })).toHaveCount(0);
});

test("the author edits and then deletes their own comment, and others get no menu", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const text = `To be edited by ${account.username} in ${testInfo.project.name}`;
  await addComment(page, text);

  // Found by its ID from here on: editing replaces its text.
  const id = await commentItem(page, text).getAttribute("id");
  const item = page.locator(`li#${id}`);
  await item.getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  const editor = item.getByLabel("Edit comment");
  await expect(editor).toHaveValue(text);
  const edited = `${text}, now edited`;
  await editor.fill(edited);
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item.getByText(edited, { exact: true })).toBeVisible();
  await expect(item.getByLabel("Edit comment")).toHaveCount(0);

  await item.getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  const dialog = page.getByRole("dialog", { name: "Delete this comment?" });
  await dialog.getByRole("button", { name: "Delete comment" }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText(edited, { exact: true })).toHaveCount(0);
  await expect(item).toContainText("[deleted by author]");

  // Sample comments by other people have no menu for this account.
  const others = page.locator("li[id^='c-s_comment']");
  if ((await others.count()) > 0) {
    await expect(others.first().getByRole("button", { name: "Comment actions" })).toHaveCount(0);
  }
});

test("the author edits their post and then deletes it", async ({ page, context, account, request }) => {
  await account.signIn(context);
  const path = await publish(page, account, `Editable post by ${account.username}`);

  await page.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`${path}/edit$`));
  await page.getByLabel("Title").fill(`Edited post by ${account.username}`);
  await page.getByLabel("Description").fill("The description, changed by its *author* after posting.");
  await page.getByLabel("I found this").check();
  await page.getByRole("button", { name: "Save" }).click();

  await expect(page).toHaveURL(new RegExp(`${path}$`));
  const card = page.locator("article").first();
  await expect(card.locator("h2")).toContainText(`Edited post by ${account.username}`);
  await expect(card.locator("em", { hasText: "author" })).toBeVisible();
  await expect(card).toContainText("Discovery");

  await card.getByRole("button", { name: "Post actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this post?" }).getByRole("button", { name: "Delete post" }).click();
  await expect(page.getByText("[deleted by author]")).toBeVisible();
  await expect(page.getByText(`Edited post by ${account.username}`)).toHaveCount(0);

  const gone = await request.get(path);
  expect(gone.status()).toBe(410);
  expect(await gone.text()).not.toContain(`Edited post by ${account.username}`);
  // Nobody else can open its edit page.
  expect((await request.get(`${path}/edit`, { maxRedirects: 0 })).status()).toBe(302);
});

test("a post deleted from a list leaves it at once", async ({ page, context, account }) => {
  await account.signIn(context);
  const title = `Listed post by ${account.username}`;
  await publish(page, account, title);
  await open(page, `/u/${account.username}`);
  const card = page.locator("article", { hasText: title });
  await card.getByRole("button", { name: "Post actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this post?" }).getByRole("button", { name: "Delete post" }).click();
  await expect(card).toHaveCount(0);
  await page.reload();
  await expect(page.locator("article", { hasText: title })).toHaveCount(0);
});

test("someone else's post has no edit page and no author menu", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, POST);
  await expect(page.locator("article").first().getByRole("button", { name: "Post actions" })).toHaveCount(0);
  const response = await page.request.get(`${POST}/edit`);
  expect(response.status()).toBe(404);
});

test("a banned account sees why it cannot comment, and the server refuses", async ({ page, context, bannedAccount, baseURL }) => {
  await bannedAccount.signIn(context);
  await open(page, POST);
  await expect(page.getByText("Commenting is paused while your account is read-only.")).toBeVisible();
  const response = await page.request.post(POST, {
    form: { intent: "comment", body: "Should not land" },
    headers: { Origin: baseURL! },
  });
  expect(response.status()).toBe(403);
});

test("the thread under a removed post takes no comments", async ({ page, context, account, baseURL }) => {
  await account.signIn(context);
  await page.goto("/p/s_post_17");
  await expect(page.getByLabel("Comment", { exact: true })).toHaveCount(0);
  const response = await page.request.post("/p/s_post_17", {
    form: { intent: "comment", body: "Should not land" },
    headers: { Origin: baseURL! },
  });
  expect(response.status()).toBe(403);
});

test.describe("without scripts", () => {
  test.use({ javaScriptEnabled: false });

  test("the comment form still posts", async ({ page, context, account }, testInfo) => {
    await account.signIn(context);
    await page.goto(POST);
    const text = `Sent without scripts by ${account.username} in ${testInfo.project.name}`;
    await page.getByLabel("Comment", { exact: true }).fill(text);
    await page.getByRole("button", { name: "Comment", exact: true }).click();
    await expect(page.getByText(text, { exact: true })).toBeVisible();
  });
});
