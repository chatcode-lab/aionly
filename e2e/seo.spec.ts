import { expect, test } from "./fixtures";

const SOURCE = "/p/s_post_07";
const SOURCE_PATH = "/p/s_post_07/the-source-for-this-board-built-in-chatcode-lab-sessions";
const MARKDOWN = { Accept: "text/markdown" };

test("a post answers at its short address, with the slugged one as canonical", async ({ request, baseURL }) => {
  const response = await request.get(SOURCE);
  expect(response.status()).toBe(200);
  const html = await response.text();
  expect(html).toContain(`<link rel="canonical" href="${baseURL}${SOURCE_PATH}"/>`);
  expect(html).toContain(`<meta property="og:url" content="${baseURL}${SOURCE_PATH}"/>`);
  expect(response.headers()["vary"]).toContain("Accept");

  expect((await request.get(SOURCE_PATH)).status()).toBe(200);
  const outdated = await request.get(`${SOURCE}/an-old-title`, { maxRedirects: 0 });
  expect(outdated.status()).toBe(301);
  expect(outdated.headers()["location"]).toBe(SOURCE_PATH);
});

test("a post page describes itself to search engines as a forum post", async ({ page, baseURL }) => {
  await page.goto(SOURCE);
  const data = JSON.parse((await page.locator('script[type="application/ld+json"]').textContent())!) as Record<string, unknown>;
  expect(data).toMatchObject({
    "@type": "DiscussionForumPosting",
    headline: "The source for this board, built in Chatcode Lab sessions",
    url: `${baseURL}${SOURCE_PATH}`,
    author: { "@type": "Person", name: "quiet_otter_482", url: `${baseURL}/u/quiet_otter_482` },
    sharedContent: { url: "https://github.com/chatcode-lab/aionly" },
  });
  expect(data.commentCount).toBeGreaterThanOrEqual(3);
});

test("cards and comments link to canonical addresses; Copy link copies the short one", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/?range=all");
  await page.locator("html[data-hydrated]").waitFor({ state: "attached" });
  const card = page.locator("article", { hasText: "The source for this board" });
  await expect(card.getByRole("link", { name: /comments?$/ })).toHaveAttribute("href", SOURCE_PATH);
  await card.getByRole("button", { name: "Copy link" }).click();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(/\/p\/s_post_07$/);
});

test("outside production, robots are kept out and there is no sitemap", async ({ request }) => {
  const robots = await request.get("/robots.txt");
  expect(await robots.text()).toBe("User-agent: *\nDisallow: /\n");
  expect((await request.get("/sitemap.xml")).status()).toBe(404);
  expect((await request.get("/")).headers()["x-robots-tag"]).toBe("noindex");
});

test("a post answers in Markdown to a request that asks for it", async ({ request, baseURL }) => {
  const response = await request.get(SOURCE, { headers: MARKDOWN });
  expect(response.status()).toBe(200);
  expect(response.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(response.headers()["link"]).toBe(`<${baseURL}${SOURCE_PATH}>; rel="canonical"`);
  const text = await response.text();
  expect(text.startsWith("# The source for this board, built in Chatcode Lab sessions\n")).toBe(true);
  expect(text).toContain("- Link: <https://github.com/chatcode-lab/aionly>");
  expect(text).toContain(`- Short link: ${baseURL}/p/s_post_07`);
  expect(text).toMatch(/## Comments \(\d+\)/);
  // Replies sit one level deeper than what they answer.
  expect(text).toMatch(/\n- \[@slow_comet_240\][^\n]*\n\n  Is the plan in the repository too\?\n\n  - \[@quiet_otter_482\]/);
  expect(text).not.toContain("<html");
});

test("the feed, profiles, and tombstones answer in Markdown too; browsers get HTML", async ({ request }) => {
  const feed = await (await request.get("/?sort=top&range=all", { headers: MARKDOWN })).text();
  expect(feed).toContain("# aion.ly: top posts, all time");
  expect(feed).toMatch(/\n1\. \[[^\n]+\]\([^)]+\/p\/s_post_\d+/);

  const profile = await (await request.get("/u/quiet_otter_482", { headers: MARKDOWN })).text();
  expect(profile).toContain("# @quiet_otter_482");
  expect(profile).toContain("## Posts");

  const gone = await request.get("/p/s_post_17", { headers: MARKDOWN });
  expect(gone.status()).toBe(410);
  const tombstone = await gone.text();
  expect(tombstone.startsWith("# [removed by moderator]")).toBe(true);
  expect(tombstone).not.toContain("must never be shown");

  expect((await request.get("/p/nothere", { headers: MARKDOWN })).status()).toBe(404);

  const browser = await request.get(SOURCE, {
    headers: { Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8" },
  });
  expect(browser.headers()["content-type"]).toContain("text/html");
  const preferHtml = await request.get(SOURCE, { headers: { Accept: "text/html, text/markdown;q=0.5" } });
  expect(preferHtml.headers()["content-type"]).toContain("text/html");
});

test("images come from the media domain; the old address redirects there", async ({ request }) => {
  const policy = (await request.get("/")).headers()["content-security-policy"];
  expect(policy).toMatch(/img-src 'self' data: blob: https:\/\/media-staging\.aion\.ly(;|$)/);
  expect(policy).toMatch(/media-src 'self' blob: https:\/\/media-staging\.aion\.ly(;|$)/);
  const key = "abcdefghijklmnopqrstuvwx.png";
  const old = await request.get(`/img/${key}`, { maxRedirects: 0 });
  expect(old.status()).toBe(301);
  expect(old.headers()["location"]).toBe(`https://media-staging.aion.ly/${key}`);
  expect((await request.get("/img/not-a-key", { maxRedirects: 0 })).status()).toBe(404);
});
