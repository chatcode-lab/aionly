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
  await page.getByLabel("Link", { exact: true }).fill(`https://e2e-${account.id.toLowerCase()}.example.com/discussion`);
  await page.getByRole("button", { name: "Check link" }).click();
  await expect(page.getByRole("button", { name: "Checked" })).toBeVisible();
  await page.getByLabel("Title").fill(title);
  await page.getByLabel("Description").fill("A post made to be edited and then deleted by its author.");
  await page.getByLabel("I made this").check();
  await page.getByLabel(/made with AI or about AI/).check();
  await expect(page.getByText("Turnstile stand-in")).toBeVisible();
  await page.getByRole("button", { name: "Publish" }).click();
  await expect(page).toHaveURL(/\/p\/[0-9a-z]{7}\/[0-9a-z-]+$/);
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

test("a comment is added with its formatting, outside links are not followed, and the draft is cleared", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const text = `Formatted by ${account.username} in ${testInfo.project.name}`;
  await page.getByLabel("Comment", { exact: true }).fill(
    `**${text}**\n\nsee [the paper](https://arxiv.org/abs/1706.03762)\n\n- one\n- two`,
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  const item = page.locator("li[id^='c-']", { has: page.locator("strong", { hasText: text }) });
  await expect(item).toBeVisible();
  await expect(item.getByText("see the paper")).toBeVisible();
  await expect(item.getByRole("button", { name: "Copy link https://arxiv.org/abs/1706.03762" })).toBeVisible();
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

test("mentions, strikethrough, site links, and copyable outside links", async ({ page, context, account }, testInfo) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await account.signIn(context);
  await open(page, POST);
  const marker = `Links from ${account.username} in ${testInfo.project.name}`;
  await page.getByLabel("Comment", { exact: true }).fill(
    `${marker}: ~~old~~ thanks @Quiet_Otter_482, see https://example.com/a/very/long/path?with=query and [our source](https://aion.ly/p/s_post_07) or [the paper](https://arxiv.org/abs/1706.03762), or mail editor@example.org or o'connor@example.org`,
  );
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const item = page.locator("li[id^='c-']", { hasText: marker });
  await expect(item).toBeVisible();

  await expect(item.locator("del")).toHaveText("old");
  const mention = item.getByRole("link", { name: "User quiet_otter_482" });
  await expect(mention).toHaveAttribute("href", "/u/quiet_otter_482");
  await expect(mention.locator("svg")).toHaveCount(1);
  await expect(item.getByRole("link", { name: "our source" })).toHaveAttribute("href", "/p/s_post_07");
  // Outside addresses are never links; a tap copies them.
  await expect(item.locator("a[href*='example.com'], a[href*='arxiv']")).toHaveCount(0);
  await expect(item.getByText("the paper")).toBeVisible();
  const copy = item.getByRole("button", { name: "Copy link https://example.com/a/very/long/path?with=query" });
  await copy.click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("https://example.com/a/very/long/path?with=query");
  await expect(item.getByRole("button", { name: "Copy link https://arxiv.org/abs/1706.03762" })).toBeVisible();
  // An email address, likewise, to copy.
  await expect(item.locator("a[href^='mailto:']")).toHaveCount(0);
  await expect(item.getByRole("button", { name: "Copy email address editor@example.org" })).toBeVisible();
  // Whole, never by its end (review F104).
  await item.getByRole("button", { name: "Copy email address o'connor@example.org" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("o'connor@example.org");

  // Editing shows the mention by name, and saving keeps it a mention.
  await item.getByRole("button", { name: "Comment actions" }).first().click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(item.getByLabel("Edit comment")).toHaveValue(/thanks @quiet_otter_482, see/);
  await item.getByRole("button", { name: "Save" }).click();
  await expect(item.getByRole("link", { name: "User quiet_otter_482" })).toBeVisible();
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

  // Other people's comments offer Report, never Edit or Delete.
  const others = page.locator("li[id^='c-s_comment']");
  if ((await others.count()) > 0) {
    await others.first().getByRole("button", { name: "Comment actions" }).first().click();
    await expect(page.getByRole("menuitem", { name: "Report" })).toBeVisible();
    await expect(page.getByRole("menuitem", { name: /Edit|Delete/ })).toHaveCount(0);
    await page.keyboard.press("Escape");
  }
});

test("the author edits their post and then deletes it", async ({ page, context, account, request }) => {
  await account.signIn(context);
  const path = await publish(page, account, `Editable post by ${account.username}`);
  const short = path.split("/").slice(0, 3).join("/");

  await page.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await page.getByRole("menuitem", { name: "Edit" }).click();
  await expect(page).toHaveURL(new RegExp(`${short}/edit$`));
  await page.getByLabel("Title").fill(`Edited post by ${account.username}`);
  await page.getByLabel("Description").fill("The description, changed by its *author* after posting.");
  await page.getByLabel("I found this").check();
  await page.getByRole("button", { name: "Save" }).click();

  // The new title gives the post a new canonical address.
  await expect(page).toHaveURL(new RegExp(`${short}/edited-post-by-`));
  const card = page.locator("article").first();
  await expect(card.locator("h2")).toContainText(`Edited post by ${account.username}`);
  await expect(card.locator("em", { hasText: "author" })).toBeVisible();
  await expect(card).toContainText("Discovery");
  // Its share cover, drawn once and cached.
  const image = new URL((await page.locator('meta[property="og:image"]').getAttribute("content"))!);
  const cover = `${image.pathname}${image.search}`;
  for (let time = 0; time < 2; time += 1) {
    const drawn = await request.get(cover);
    expect(drawn.status()).toBe(200);
    expect(drawn.headers()["content-type"]).toBe("image/png");
  }

  await card.getByRole("button", { name: "Post actions" }).click();
  await page.getByRole("menuitem", { name: "Delete" }).click();
  await page.getByRole("dialog", { name: "Delete this post?" }).getByRole("button", { name: "Delete post" }).click();
  await expect(page.getByText("[deleted by author]")).toBeVisible();
  await expect(page.getByText(`Edited post by ${account.username}`)).toHaveCount(0);

  const gone = await request.get(short);
  expect(gone.status()).toBe(410);
  expect(await gone.text()).not.toContain(`Edited post by ${account.username}`);
  // Nobody else can open its edit page.
  expect((await request.get(`${short}/edit`, { maxRedirects: 0 })).status()).toBe(302);
  // The cached cover goes with it, at once.
  expect((await request.get(cover)).status()).toBe(404);
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

test("someone else's post has no edit page, and its menu only reports", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, POST);
  await page.locator("article").first().getByRole("button", { name: "Post actions" }).click();
  await expect(page.getByRole("menuitem", { name: "Report" })).toBeVisible();
  await expect(page.getByRole("menuitem", { name: /Edit|Delete|Remove|Pin/ })).toHaveCount(0);
  await page.keyboard.press("Escape");
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
    // In the thread of the page the form lands on, not the text still in the box.
    await expect(commentItem(page, text)).toBeVisible();
  });
});

test("a mention shows on the private Mentions page of whoever it names", async ({ page, context, account, otherAccount, browser }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const text = `Over to @${otherAccount.username}, from ${account.username} in ${testInfo.project.name}`;
  await page.getByLabel("Comment", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const item = page.locator("li[id^='c-']", { has: page.getByRole("link", { name: `User ${otherAccount.username}` }) }).last();
  await expect(item).toBeVisible();

  const other = await browser.newContext();
  await otherAccount.signIn(other);
  const theirs = await other.newPage();
  await open(theirs, "/");
  // A new mention marks the account menu, as open reports do for admins.
  const menu = theirs.locator("header").getByRole("button", { name: /account/i });
  await expect(menu).toHaveAccessibleName(/new mentions/);
  await menu.click();
  await expect(theirs.getByRole("menuitem", { name: /Mentions\s*\d+\+?\s*new/ })).toBeVisible();
  await theirs.getByRole("menuitem", { name: /Mentions/ }).click();
  await expect(theirs).toHaveURL(/\/mentions$/);
  await expect(theirs.getByRole("heading", { name: "Mentions", level: 1 })).toBeVisible();
  const mention = theirs.locator("li", { hasText: `from ${account.username} in ${testInfo.project.name}` });
  await expect(mention).toBeVisible();
  // Shown, they count as seen: the menu's mark clears, while each keeps "New" until passed over.
  await expect(mention.getByText("New", { exact: true })).toBeVisible();
  await expect(menu).not.toHaveAccessibleName(/new mentions/);
  await expect(async () => {
    await theirs.mouse.move(1, 1);
    await mention.hover();
    await expect(mention.getByText("New", { exact: true })).toHaveCount(0, { timeout: 500 });
  }).toPass();
  await expect(mention.getByRole("link", { name: /small tool/ })).toHaveAttribute("href", /^\/p\/s_post_15\//);
  // Nobody else sees it, and search engines are kept out.
  await expect(theirs.locator('meta[name="robots"]')).toHaveAttribute("content", /noindex/);
  await open(page, "/mentions");
  await expect(page.getByText(`from ${account.username} in ${testInfo.project.name}`)).toHaveCount(0);
  await other.close();
});

test("the formatting buttons and shortcuts write Markdown into a comment", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const box = page.getByLabel("Comment", { exact: true });
  const toolbar = page.getByRole("toolbar", { name: "Formatting" }).first();
  const word = `Toolbar ${account.username} ${testInfo.project.name}`;
  await box.fill(word);
  await box.selectText();
  await toolbar.getByRole("button", { name: "Bold" }).click();
  await expect(box).toHaveValue(`**${word}**`);
  // Pressed again, the marks come off; the shortcut puts them back.
  await toolbar.getByRole("button", { name: "Bold" }).click();
  await expect(box).toHaveValue(word);
  await box.press("ControlOrMeta+b");
  await expect(box).toHaveValue(`**${word}**`);
  // The caret to the end; End does not move it on a Mac.
  await box.evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(element.value.length, element.value.length));
  await box.pressSequentially("\n");
  await toolbar.getByRole("button", { name: "Bulleted list" }).click();
  await box.pressSequentially("one");
  await expect(box).toHaveValue(`**${word}**\n- one`);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const item = page.locator("li[id^='c-']", { has: page.locator("strong", { hasText: word }) });
  await expect(item).toBeVisible();
  await expect(item.locator("ul li")).toHaveText("one");
});

test("a saved comment is listed under Saved, Comments, and can be unsaved there", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, POST);
  const text = `To keep, by ${account.username} in ${testInfo.project.name}`;
  await page.getByLabel("Comment", { exact: true }).fill(text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  const item = page.locator("li[id^='c-']", { has: page.getByText(text, { exact: true }) });
  await item.getByRole("button", { name: "Save comment" }).first().click();
  await expect(item.getByRole("button", { name: "Remove comment from saved" }).first()).toHaveAttribute("aria-pressed", "true");

  await open(page, "/saved");
  await page.getByRole("navigation", { name: "Saved" }).getByRole("link", { name: "Comments" }).click();
  await expect(page.getByRole("heading", { name: "Saved comments" })).toBeVisible();
  const saved = page.locator("li", { hasText: text });
  await expect(saved).toBeVisible();
  await expect(saved.getByRole("link", { name: /small tool/ })).toHaveAttribute("href", /\?c=/);
  const unsaved = page.waitForResponse((response) => response.url().endsWith("/api/save"));
  await saved.getByRole("button", { name: "Remove comment from saved" }).click();
  await expect(saved.getByRole("button", { name: "Save comment" })).toHaveAttribute("aria-pressed", "false");
  const answer = await unsaved;
  expect(answer.status(), await answer.text()).toBe(200);
  await page.reload();
  await expect(page.getByText(text)).toHaveCount(0);
});

test("the 30th comment, which turns the discussion best first, clears its box and draft and is shown", async ({ page, context, account, newAccount, browser, baseURL }, testInfo) => {
  await account.signIn(context);
  const path = await publish(page, account, `Thirty comments for ${account.username}`);
  const postId = path.split("/")[2]!;

  // Twenty-nine comments from six other members, five each at most, the
  // burst a member may send in a minute.
  for (let member = 0, sent = 0; sent < 29; member += 1) {
    const other = await browser.newContext({ baseURL });
    await newAccount().signIn(other);
    for (let n = 0; n < 5 && sent < 29; n += 1, sent += 1) {
      const response = await other.request.post(`/p/${postId}`, {
        form: { intent: "comment", body: `Comment ${sent + 1} of 29, from member ${member + 1}` },
        headers: { Origin: baseURL! },
      });
      expect(response.status(), await response.text()).toBe(200);
    }
    await other.close();
  }

  await open(page, path);
  const order = page.getByRole("navigation", { name: "Order comments" });
  await expect(order.getByRole("link", { name: "Oldest" })).toHaveAttribute("aria-current", "true");
  const text = `The thirtieth, from ${account.username} in ${testInfo.project.name}`;
  const box = page.getByLabel("Comment", { exact: true });
  await box.fill(text);
  await page.getByRole("button", { name: "Comment", exact: true }).click();

  await expect(commentItem(page, text)).toBeVisible();
  await expect(order.getByRole("link", { name: "Best" })).toHaveAttribute("aria-current", "true");
  await expect(box).toHaveValue("");
  await expect(page).toHaveURL(/#c-[0-9A-Za-z]{12}$/);
  expect(await page.evaluate((key) => localStorage.getItem(key), `draft:comment:${postId}:top`)).toBeNull();
  await page.reload();
  await expect(box).toHaveValue("");
  await expect(page.getByText(text, { exact: true })).toHaveCount(1);
});

test("another order of a discussion shows the votes loaded with it", async ({ page, context, account, otherAccount, browser, baseURL }) => {
  await account.signIn(context);
  const path = await publish(page, account, `Votes across orders for ${account.username}`);
  const postId = path.split("/")[2]!;
  const theirs = await browser.newContext({ baseURL });
  await otherAccount.signIn(theirs);
  for (const body of ["The first answer, to vote on.", "The second answer, left alone."]) {
    const response = await theirs.request.post(`/p/${postId}`, { form: { intent: "comment", body }, headers: { Origin: baseURL! } });
    expect(response.status()).toBe(200);
  }
  await theirs.close();

  await open(page, path);
  const item = page.locator("li[id^='c-']", { hasText: "The first answer, to vote on." });
  const up = item.getByRole("group", { name: "Vote on this comment" }).getByRole("button", { name: "Upvote" });
  await expect(up).toHaveAttribute("aria-pressed", "false");
  // The same account votes from another tab, which this page does not see.
  const id = (await item.getAttribute("id"))!.slice("c-".length);
  const vote = await context.request.post("/api/vote", { data: { type: "comment", id, value: 1 }, headers: { Origin: baseURL! } });
  expect(vote.ok(), await vote.text()).toBe(true);
  await page.getByRole("navigation", { name: "Order comments" }).getByRole("link", { name: "Newest" }).click();
  await expect(page).toHaveURL(/order=new/);
  await expect(up).toHaveAttribute("aria-pressed", "true");
});
