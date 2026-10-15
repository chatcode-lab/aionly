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

/** The size a PNG says it is, from its header. */
function pngSize(bytes: Buffer): { width: number; height: number } {
  expect(bytes.subarray(0, 8).toString("hex")).toBe("89504e470d0a1a0a");
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

/** A meta tag's content, by property or name. */
const metaOf = (html: string, key: string) =>
  new RegExp(`<meta (?:property|name)="${key.replace(/[:.]/g, "\\$&")}" content="([^"]*)"/>`).exec(html)?.[1];

test("every kind of page previews with its own title, description, and a drawn cover", async ({ request, baseURL }) => {
  const pages: Array<[string, RegExp, string]> = [
    ["/", /^aion\.ly: people and their agents on all things AI$/, "/og/site.png"],
    [SOURCE, /^The source for this board, built in Chatcode Lab sessions$/, "/og/p/s_post_07.png?v="],
    ["/u/quiet_otter_482", /^quiet_otter_482$/, "/og/u/quiet_otter_482.png?v="],
    ["/manifesto", /^Manifesto$/, "/og/page/manifesto.png"],
    ["/agents", /^Connect your agent$/, "/og/page/agents.png"],
    ["/rules", /^Rules$/, "/og/page/rules.png"],
    ["/settings", /^Sign in$/, "/og/site.png"],
  ];
  for (const [path, title, cover] of pages) {
    const html = await (await request.get(path)).text();
    expect(metaOf(html, "og:title"), path).toMatch(title);
    expect(metaOf(html, "og:description")?.length, path).toBeGreaterThan(20);
    expect(metaOf(html, "twitter:card"), path).toBe("summary_large_image");
    const image = metaOf(html, "og:image")!;
    expect(image.startsWith(`${baseURL}${cover}`), `${path}: ${image}`).toBe(true);
    expect(metaOf(html, "twitter:image"), path).toBe(image);
    expect(metaOf(html, "og:image:alt"), path).toBeTruthy();

    const picture = await request.get(image.replaceAll("&amp;", "&"));
    expect(picture.status(), image).toBe(200);
    expect(picture.headers()["content-type"]).toBe("image/png");
    expect(pngSize(await picture.body()), image).toEqual({ width: 1200, height: 630 });
  }
});

test("covers exist only for what pages show, and only at their current version", async ({ request }) => {
  const stale = await request.get("/og/p/s_post_07.png?v=made-up", { maxRedirects: 0 });
  expect(stale.status()).toBe(302);
  expect(stale.headers()["location"]).toMatch(/^\/og\/p\/s_post_07\.png\?v=[0-9a-z]+$/);
  expect((await request.get("/og/u/quiet_otter_482.png", { maxRedirects: 0 })).status()).toBe(302);
  expect((await request.get("/og/page/nowhere.png")).status()).toBe(404);
  // A removed post's cover is gone with it.
  expect((await request.get("/og/p/s_post_17.png")).status()).toBe(404);
  expect((await request.get("/og/u/nobody_at_all.png")).status()).toBe(404);
  const html = await (await request.get("/p/s_post_17")).text();
  expect(metaOf(html, "robots")).toBe("noindex");
  expect(metaOf(html, "og:image")).toMatch(/\/og\/site\.png$/);
});

test("the manifesto is a page, the repository's own file, and Markdown for agents", async ({ page, request }) => {
  await page.goto("/manifesto");
  await expect(page.getByRole("heading", { level: 1, name: "The aion.ly manifesto" })).toBeVisible();
  for (const name of ["People decide", "People answer for their agents", "Open and transparent"]) {
    await expect(page.getByRole("heading", { level: 2, name })).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "Rules" }).first()).toHaveAttribute("href", "/rules");
  const markdown = await request.get("/manifesto.md");
  expect(markdown.headers()["content-type"]).toBe("text/markdown; charset=utf-8");
  expect(await markdown.text()).toMatch(/^# The aion\.ly manifesto\n/);
  const feed = await (await request.get("/", { headers: MARKDOWN })).text();
  expect(feed).toContain("people and their agents discover and discuss all things AI");
});

test("every public page is Markdown at its address plus .md", async ({ request, baseURL }) => {
  const markdown = async (path: string) => {
    const response = await request.get(path);
    expect(response.status(), path).toBe(200);
    expect(response.headers()["content-type"], path).toBe("text/markdown; charset=utf-8");
    return response.text();
  };
  expect(await markdown("/index.md")).toMatch(/^# aion\.ly: top posts/);
  expect(await markdown("/index.md?sort=new&range=all")).toMatch(/^# aion\.ly: new posts, all time/);
  expect(await markdown(`${SOURCE}.md`)).toMatch(/^# The source for this board/);
  expect(await markdown(`${SOURCE_PATH}.md`)).toMatch(/^# The source for this board/);
  expect(await markdown("/u/quiet_otter_482.md")).toContain("quiet_otter_482");
  expect(await markdown("/manifesto.md")).toMatch(/^# The aion\.ly manifesto/);
  expect(await markdown("/agents.md")).toMatch(/^# Connecting to aion\.ly, for AI agents/);
  expect(await markdown("/supporter.md")).toMatch(/^# Support aion\.ly\n[\s\S]*## What supporters get\n\n- \*\*Text posts:\*\*/);

  const rules = await markdown("/rules.md");
  expect(rules).toMatch(/^# Rules\n/);
  expect(rules).toContain("## Your own words");
  expect(rules).toContain(`[manifesto](${baseURL}/manifesto)`);
  expect(rules).not.toMatch(/<[a-z]/);
  expect(await markdown("/terms.md")).toMatch(/^# Terms\n/);
  expect(await markdown("/privacy.md")).toMatch(/^# Privacy\n/);
  expect((await request.get("/rules", { headers: MARKDOWN })).headers()["content-type"]).toBe("text/markdown; charset=utf-8");

  // An old name's profile moves on to the current one's Markdown.
  const moved = await request.get("/u/old_otter_name.md", { maxRedirects: 0 });
  expect(moved.status()).toBe(301);
  expect(moved.headers()["location"]).toBe(`${baseURL}/u/quiet_otter_482.md`);
  // Private pages have no Markdown.
  expect((await request.get("/settings.md")).status()).toBe(404);
  // Pages point to their Markdown.
  expect(await (await request.get("/rules")).text()).toContain('<link rel="alternate" type="text/markdown" href="/rules.md"/>');
});
