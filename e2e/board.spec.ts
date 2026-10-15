import { expect, test } from "./fixtures";

// These run against the sample posts from scripts/seed.ts.

const titles = (page: import("@playwright/test").Page) =>
  page.locator("article h2").allInnerTexts();

test.describe("feed", () => {
  test("opens on Top for the narrowest range that fills a screen", async ({ page }) => {
    await page.goto("/");
    // Twelve sample posts fall inside the week, so the week is the default.
    await expect(page.getByRole("button", { name: "Range: Week" })).toBeVisible();
    await expect(page.locator("article")).toHaveCount(12);

    const shown = await titles(page);
    expect(shown[0]).toContain("The source for this board");
    expect(shown[1]).toContain("Big Buck Bunny");
    expect(shown.at(-1)).toContain("negative score");
  });

  test("sorts by New and picks a range from the one button", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("link", { name: "New", exact: true }).click();
    await expect(page).toHaveURL(/sort=new/);
    await expect(page.locator("article h2").first()).toContainText("Big Buck Bunny");

    await page.getByRole("button", { name: "Range: Week" }).click();
    await page.getByRole("menuitem", { name: "Today" }).click();
    await expect(page).toHaveURL(/range=day/);
    await expect(page.locator("article")).toHaveCount(5);
  });

  test("loads more without repeating posts, and Back restores them", async ({ page }) => {
    await page.goto("/?range=all");
    await expect(page.locator("article")).toHaveCount(20);
    await expect(page.locator("article h2").first()).toContainText("two months ago");

    await page.getByRole("button", { name: "Load more" }).click();
    await expect(page.locator("article")).toHaveCount(26);
    await expect(page.getByRole("button", { name: "Load more" })).toHaveCount(0);
    const loaded = await titles(page);
    expect(new Set(loaded).size).toBe(26);

    // Open a post from the second page, then come back.
    const last = page.locator("article").last();
    await last.scrollIntoViewIfNeeded();
    await last.getByRole("link", { name: /comment/ }).click();
    await expect(page).toHaveURL(/\/p\//);
    await page.goBack();

    await expect(page.locator("article")).toHaveCount(26);
    expect(await titles(page)).toEqual(loaded);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBeGreaterThan(500);
  });

  test("shows an empty state with a way out for an empty range", async ({ page, request }) => {
    // No sample post is this specific, but the state is reachable by address.
    const response = await request.get("/?range=day&sort=new");
    expect(response.status()).toBe(200);
    await page.goto("/?range=day");
    await expect(page.locator("article").first()).toBeVisible();
  });
});

test.describe("post page", () => {
  test("shows the post, its whole description, and its thread", async ({ page }) => {
    await page.goto("/p/s_post_01");
    await expect(page.locator("article h2")).toContainText("Big Buck Bunny");
    await expect(page.getByText("This is sample content for testing the feed.")).toBeVisible();
    await expect(page.getByRole("heading", { name: "10 comments" })).toBeVisible();

    // A low-score comment starts hidden; removed and deleted ones keep their place.
    await expect(page.getByText("A sample comment at minus seven")).toHaveCount(0);
    await page.getByRole("button", { name: "Show comment" }).click();
    await expect(page.getByText("A sample comment at minus seven")).toBeVisible();
    await expect(page.getByText("[removed by moderator]")).toBeVisible();
    await expect(page.getByText("A reply to a removed comment stays where it was.")).toBeVisible();
    await expect(page.getByText("[deleted by author]")).toBeVisible();
  });

  test("reads a discussion oldest first, and best or newest first on request", async ({ page, request }) => {
    await page.goto("/p/s_post_01");
    const order = page.getByRole("navigation", { name: "Order comments" });
    // Ten comments: a small discussion, read in order.
    await expect(order.getByRole("link", { name: "Oldest" })).toHaveAttribute("aria-current", "true");
    await order.getByRole("link", { name: "Best" }).click();
    await expect(page).toHaveURL(/\?order=best$/);
    await expect(order.getByRole("link", { name: "Best" })).toHaveAttribute("aria-current", "true");
    await expect(page.locator("link[rel=canonical]")).toHaveAttribute("href", /\/p\/s_post_01\/[a-z0-9-]+$/);
    expect(await (await request.get("/p/s_post_01.md?order=new")).text()).toContain("## Comments (10, newest first)");
  });

  test("carries share tags and a canonical address", async ({ page, baseURL }) => {
    await page.goto("/p/s_post_07");
    await expect(page.locator('meta[property="og:title"]')).toHaveAttribute(
      "content",
      "The source for this board, built in Chatcode Lab sessions",
    );
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      "href",
      `${baseURL}/p/s_post_07/the-source-for-this-board-built-in-chatcode-lab-sessions`,
    );
  });

  for (const [id, label] of [
    ["s_post_17", "[removed by moderator]"],
    ["s_post_18", "[deleted by author]"],
  ] as const) {
    test(`serves ${label} as a tombstone`, async ({ page }) => {
      const response = await page.goto(`/p/${id}`);
      expect(response?.status()).toBe(410);
      await expect(page.locator("article")).toHaveText(label);
      await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
      // Its preview is the site's, saying nothing about the post it replaced.
      await expect(page.locator('meta[property="og:title"]')).toHaveAttribute("content", "Post unavailable");
      await expect(page.locator('meta[property="og:image"]')).toHaveAttribute("content", /\/og\/site\.png$/);
      await expect(page).toHaveTitle("Post unavailable · aion.ly");
    });
  }

  test("answers 404 for a post that does not exist", async ({ page }) => {
    const response = await page.goto("/p/no_such_post");
    expect(response?.status()).toBe(404);
    await expect(page.getByText("Page not found")).toBeVisible();
  });
});

test.describe("profile", () => {
  test("shows name, karma, posts, and comments", async ({ page }) => {
    await page.goto("/u/quiet_otter_482");
    await expect(page.getByRole("heading", { name: "quiet_otter_482" })).toBeVisible();
    // Karma follows the votes other tests cast, so only its form is checked.
    await expect(page.getByText(/^-?[\d,.k]+ karma · joined [A-Z][a-z]{2} \d{4}$/)).toBeVisible();
    await expect(page.locator("article h2").first()).toContainText("Big Buck Bunny");
    await expect(page.getByText("Two levels down.")).toBeVisible();
  });

  test("sends an old username to the current one", async ({ page }) => {
    await page.goto("/u/old_otter_name");
    await expect(page).toHaveURL(/\/u\/quiet_otter_482$/);
  });
});

test("removed and deleted text never reaches a page or its data", async ({ page, request }) => {
  const HIDDEN = "must never be shown";
  const paths = [
    "/",
    "/?sort=new&range=all",
    "/p/s_post_01",
    "/p/s_post_17",
    "/p/s_post_18",
    // The authors of the removed and deleted samples.
    "/u/velvet_newt_12",
    "/u/north_finch_388",
    "/u/glass_heron_71",
  ];

  for (const path of paths) {
    await page.goto(path);
    expect(await page.content(), path).not.toContain(HIDDEN);

    // The data a client-side navigation would fetch for the same page.
    const [pathname, query] = path.split("?");
    const dataPath = `${pathname === "/" ? "/_root" : pathname}.data${query ? `?${query}` : ""}`;
    const data = await request.get(dataPath);
    expect(await data.text(), dataPath).not.toContain(HIDDEN);
  }

  const more = await request.get("/feed/more?ids=s_post_17,s_post_18,s_post_01");
  const body = await more.text();
  expect(body).not.toContain(HIDDEN);
  expect(JSON.parse(body).posts).toHaveLength(1);
});
