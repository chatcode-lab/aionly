import type { Locator, Page, TestInfo } from "@playwright/test";

import { expect, open, test } from "./fixtures";

// Each test votes on its own post in each viewport, so tests running at
// once never move each other's scores. All are on the first page of All time.
const TARGETS: Record<string, Record<string, string>> = {
  counts: {
    desktop: "Attention Is All You Need",
    phone: "The source for this board",
    narrow: "a small tool, three weeks old",
  },
  back: {
    desktop: "Tears of Steel, a third open movie",
    phone: "a deliberately long title",
    narrow: "something from two months ago",
  },
};

function target(page: Page, testInfo: TestInfo, test: keyof typeof TARGETS = "counts"): Locator {
  return page.locator("article", { hasText: TARGETS[test][testInfo.project.name] });
}

/** The visible vote control: beside the card on desktop, in its footer on phones. */
function votes(card: Locator): Locator {
  return card.getByRole("group", { name: "Vote on this post" }).locator("visible=true");
}

async function score(card: Locator): Promise<number> {
  const label = await votes(card).locator("[aria-label$='points']").getAttribute("aria-label");
  return Number(label!.split(" ")[0]);
}

test("signed out, voting and saving open sign-in", async ({ page }, testInfo) => {
  await open(page, "/?range=all");
  const card = target(page, testInfo);
  await votes(card).getByRole("button", { name: "Upvote" }).click();
  await expect(page.getByRole("dialog", { name: "Sign in to vote on posts" })).toBeVisible();
  await page.keyboard.press("Escape");

  await card.getByRole("button", { name: "Save post" }).click();
  await expect(page.getByRole("dialog", { name: "Sign in to save posts" })).toBeVisible();
});

test("a vote counts once, survives a reload, and can be cleared", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, "/?range=all");
  const card = target(page, testInfo);
  const before = await score(card);

  const up = votes(card).getByRole("button", { name: "Upvote" });
  const saved = page.waitForResponse("**/api/vote");
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");
  expect((await saved).ok()).toBe(true);
  await expect.poll(() => score(card)).toBe(before + 1);

  await open(page, "/?range=all");
  await expect(votes(target(page, testInfo)).getByRole("button", { name: "Upvote" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect.poll(() => score(target(page, testInfo))).toBe(before + 1);

  // Down replaces up: two points, not one.
  await votes(target(page, testInfo)).getByRole("button", { name: "Downvote" }).click();
  await expect.poll(() => score(target(page, testInfo))).toBe(before - 1);
  await votes(target(page, testInfo)).getByRole("button", { name: "Downvote" }).click();
  await expect.poll(() => score(target(page, testInfo))).toBe(before);
});

test("a vote shows again after Back, on a page restored from memory", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  await open(page, "/?range=all");
  const up = votes(target(page, testInfo, "back")).getByRole("button", { name: "Upvote" });
  await up.click();
  await expect(up).toHaveAttribute("aria-pressed", "true");

  await page.getByRole("link", { name: "Sample post: Big Buck Bunny, an open movie on YouTube" }).first().scrollIntoViewIfNeeded();
  await page.locator("article", { hasText: "Big Buck Bunny" }).getByRole("link", { name: /comments?$/ }).click();
  await expect(page).toHaveURL(/\/p\//);
  await page.goBack();
  await expect(votes(target(page, testInfo, "back")).getByRole("button", { name: "Upvote" })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  // Clean up, so the post's score stays where other tests expect it.
  await votes(target(page, testInfo, "back")).getByRole("button", { name: "Upvote" }).click();
  await expect(votes(target(page, testInfo, "back")).getByRole("button", { name: "Upvote" })).toHaveAttribute(
    "aria-pressed",
    "false",
  );
});

test("comments take votes on the post page", async ({ page, context, account }, testInfo) => {
  await account.signIn(context);
  // Each viewport its own comment, for the same reason as the posts.
  const comment = {
    desktop: "Is the plan in the repository too?",
    phone: "Bookmarked.",
    narrow: "Yes, under docs. It is the first file to read.",
  }[testInfo.project.name]!;
  await open(page, "/?range=all");
  await page.locator("article", { hasText: "The source for this board" }).getByRole("link", { name: /comments?$/ }).click();

  const item = page.locator("li", { hasText: comment }).last();
  const group = item.getByRole("group", { name: "Vote on this comment" }).first();
  const label = async () =>
    Number((await group.locator("[aria-label$='points']").getAttribute("aria-label"))!.split(" ")[0]);
  const before = await label();
  const saved = page.waitForResponse("**/api/vote");
  await group.getByRole("button", { name: "Upvote" }).click();
  expect((await saved).ok()).toBe(true);
  await expect.poll(label).toBe(before + 1);
  await page.reload();
  await expect(group.getByRole("button", { name: "Upvote" })).toHaveAttribute("aria-pressed", "true");
  await group.getByRole("button", { name: "Upvote" }).click();
  await expect.poll(label).toBe(before);
});

test("saved posts are listed newest first and can be unsaved", async ({ page, context, account }) => {
  await account.signIn(context);
  await open(page, "/?range=all");
  await page.locator("article", { hasText: "Attention Is All You Need" }).getByRole("button", { name: "Save post" }).click();
  await page.locator("article", { hasText: "Sintel, a second open movie" }).getByRole("button", { name: "Save post" }).click();
  await expect(
    page.locator("article", { hasText: "Sintel, a second open movie" }).getByRole("button", { name: "Remove from saved" }),
  ).toBeVisible();

  await page.locator("header").getByRole("link", { name: "Saved", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Saved posts" })).toBeVisible();
  const titles = page.locator("article h2");
  await expect(titles).toHaveCount(2);
  await expect(titles.first()).toContainText("Sintel");
  await expect(titles.last()).toContainText("Attention Is All You Need");

  // A reload is not a navigation the app can hold, so it waits here.
  const removed = page.waitForResponse("**/api/save");
  await page.locator("article", { hasText: "Sintel" }).getByRole("button", { name: "Remove from saved" }).click();
  await removed;
  await page.reload();
  await expect(page.locator("article h2")).toHaveCount(1);
});

test("the saved list is private", async ({ page }) => {
  await page.goto("/saved");
  await expect(page).toHaveURL(/\/signin\?next=%2Fsaved$/);
});

test("a vote from another site is refused", async ({ page, context, account }) => {
  await account.signIn(context);
  await page.goto("/");
  const response = await page.request.post("/api/vote", {
    data: { type: "post", id: "s_post_01", value: 1 },
    headers: { Origin: "https://attacker.example" },
  });
  expect(response.status()).toBe(403);
});

test("a banned account cannot vote or save", async ({ page, context, bannedAccount, baseURL }) => {
  await bannedAccount.signIn(context);
  await page.goto("/");
  for (const [path, data] of [
    ["/api/vote", { type: "post", id: "s_post_01", value: 1 }],
    ["/api/save", { id: "s_post_01", saved: true }],
  ] as const) {
    const response = await page.request.post(path, { data, headers: { Origin: baseURL! } });
    expect(response.status(), await response.text()).toBe(403);
  }
});
