import { expect, test } from "./fixtures";

// These run against the sample posts from scripts/seed.ts.

test.describe("search", () => {
  test("opens in place of the feed's controls, lists the posts found, and closes back to the feed", async ({ page }) => {
    await page.goto("/");
    const header = page.locator("header");
    const field = header.getByRole("searchbox", { name: "Search posts" });
    await header.getByRole("link", { name: "Search" }).click();
    await expect(field).toBeFocused();
    await expect(header.getByRole("link", { name: "Top", exact: true })).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Refresh" })).toHaveCount(0);

    // Escape puts the controls back, and the focus where it was.
    await field.press("Escape");
    await expect(header.getByRole("button", { name: "Refresh" })).toBeVisible();
    await expect(header.getByRole("link", { name: "Search" })).toBeFocused();

    await header.getByRole("link", { name: "Search" }).click();
    await field.fill("open movies");
    await field.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=open\+movies$/);
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("3 posts match “open movies”");
    const titles = page.locator("main article h2");
    await expect(titles).toHaveCount(3);
    for (const title of await titles.allInnerTexts()) expect(title).toMatch(/open movie/);
    await expect(titles.first().locator("mark")).toHaveText(["open", "movie"]);
    await expect(field).toHaveValue("open movies");
    await expect(page.locator('meta[name="robots"]')).toHaveAttribute("content", "noindex");
    // Nothing of the feed shows, above the results or in the bar.
    await expect(page.getByText("Load more")).toHaveCount(0);
    await expect(header.getByRole("button", { name: "Refresh" })).toHaveCount(0);

    // Only Return searches: there is no button for it, and Close sits inside the field.
    await expect(header.getByRole("button", { name: "Search" })).toHaveCount(0);
    const fieldBox = (await field.boundingBox())!;
    const closeBox = (await header.getByRole("link", { name: "Close search" }).boundingBox())!;
    expect(closeBox.x + closeBox.width).toBeLessThanOrEqual(fieldBox.x + fieldBox.width + 1);
    expect(closeBox.x).toBeGreaterThan(fieldBox.x + fieldBox.width / 2);
    await field.fill("Attention transformer");
    await field.press("Enter");
    await expect(page.getByRole("heading", { level: 1 })).toHaveText("1 post matches “Attention transformer”");
    await expect(page.locator("main article")).toContainText("2017 transformer paper");
    await expect(page.locator("main article")).toContainText("arxiv.org");

    await page.locator("main article h2 a").click();
    await expect(page).toHaveURL(/\/p\/s_post_08\/attention-is-all-you-need/);
    await page.goBack();
    await header.getByRole("link", { name: "Close search" }).click();
    await expect(page).toHaveURL(/\/$/);
    await expect(header.getByRole("button", { name: "Refresh" })).toBeVisible();
  });

  test("says when nothing matches, and finds no removed or deleted post", async ({ page }) => {
    await page.goto("/search?q=never+shown");
    await expect(page.getByRole("heading", { name: "No posts match “never shown”" })).toBeVisible();
    await page.getByRole("link", { name: "Back to the feed" }).click();
    await expect(page.locator("article").first()).toBeVisible();

    await page.goto("/search");
    await expect(page.getByRole("heading", { name: "Search posts" })).toBeVisible();
    await expect(page.locator("header").getByRole("searchbox", { name: "Search posts" })).toHaveValue("");
  });
});

test.describe("search without scripts", () => {
  test.use({ javaScriptEnabled: false });

  test("the button leads to the search page, whose field searches", async ({ page }) => {
    await page.goto("/");
    await page.locator("header").getByRole("link", { name: "Search" }).click();
    await expect(page).toHaveURL(/\/search$/);
    const field = page.locator("header").getByRole("searchbox", { name: "Search posts" });
    await field.fill("bunny");
    await field.press("Enter");
    await expect(page).toHaveURL(/\/search\?q=bunny$/);
    await expect(page.locator("main article h2")).toHaveText(["Sample post: Big Buck Bunny, an open movie on YouTube youtube.com"]);
  });
});
