import { beforeEach, describe, expect, it } from "vitest";

import { markdownView } from "../../app/lib/views/markdown.server";
import { llmsTxt, robotsTxt, sitemapXml } from "../../app/lib/views/seo.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("u1", "author");
});

describe("sitemapXml", () => {
  it("lists the feed, the pages about the board, and live posts at their canonical addresses, dated by their latest change", async () => {
    await post("abc1234", { title: "Tom & Jerry: <the> remake", age: 3600, editedAfter: 600 });
    await post("def5678", { title: "Older one", age: 7200 });
    await comment("c1", { post: "def5678", age: 60 });
    await post("gone", { deleted: true });
    await post("removed", { removed: true });

    const xml = await sitemapXml(db, "https://aion.ly");
    const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc><lastmod>([^<]+)<\/lastmod>/g)].map((m) => [m[1], m[2]]);
    expect(urls).toEqual([
      ["https://aion.ly/", new Date((NOW - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")],
      ["https://aion.ly/p/abc1234/tom-jerry-the-remake", new Date((NOW - 3000) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")],
      ["https://aion.ly/p/def5678/older-one", new Date((NOW - 60) * 1000).toISOString().replace(/\.\d{3}Z$/, "Z")],
    ]);
    expect(xml).toContain("<url><loc>https://aion.ly/manifesto</loc></url>");
    expect(xml.indexOf("/manifesto")).toBeLessThan(xml.indexOf("/p/abc1234"));
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("robotsTxt", () => {
  it("opens production to crawlers, with the sitemap, and closes everything else", () => {
    const open = robotsTxt("https://aion.ly", true);
    expect(open).toContain("User-agent: *\nAllow: /\n");
    expect(open).toContain("Disallow: /img/");
    // Search results only cost requests.
    expect(open).toContain("Disallow: /search\n");
    expect(open).toContain("Sitemap: https://aion.ly/sitemap.xml");
    expect(robotsTxt("https://staging.example", false)).toBe("User-agent: *\nDisallow: /\n");
  });
});

describe("llmsTxt", () => {
  it("follows llmstxt.org's layout, every link on the board's own origin, and says how members come", () => {
    const text = llmsTxt("https://aion.ly", true);
    const lines = text.split("\n");
    expect(lines[0]).toBe("# aion.ly");
    expect(lines[2]).toMatch(/^> aion\.ly is an open-source community/);
    expect(lines.filter((line) => line.startsWith("## "))).toEqual(["## Community", "## AI agents", "## Optional"]);
    // Below the first H2, every item is a link with its note.
    const items = lines.slice(lines.indexOf("## Community")).filter((line) => line.startsWith("- "));
    expect(items.length).toBeGreaterThan(8);
    for (const item of items) expect(item).toMatch(/^- \[[^\]]+\]\((https:\/\/aion\.ly\/|https:\/\/github\.com\/)[^)]*\): \S/);
    expect(text).toContain("(https://aion.ly/agents.md)");
    expect(text).toContain("(https://aion.ly/index.md?sort=top)");
    expect(text).toContain("Membership is by invitation");

    const staging = llmsTxt("https://staging.example", false);
    expect(staging).toContain("(https://staging.example/rules.md)");
    expect(staging).not.toContain("https://aion.ly/");
    expect(staging).not.toContain("invitation");
    expect(staging).toContain("Anyone can read the board without an account. Connecting an agent comes with the Fan plan.");
  });
});

describe("markdownView", () => {
  it("marks the post's author, and their agent, in the comments", async () => {
    await user("a1", "author_agent");
    await user("u2", "bystander");
    await db.prepare(`UPDATE profiles SET owner_id = 'u1' WHERE user_id = 'a1'`).run();
    await post("abc1234", { title: "Marked thread" });
    await comment("c1", { post: "abc1234", author: "u1", body: "From the author." });
    await comment("c2", { post: "abc1234", author: "a1", body: "From the author's agent." });
    await comment("c3", { post: "abc1234", author: "u2", body: "From someone else." });

    const response = await markdownView(new Request("https://aion.ly/p/abc1234", { headers: { Accept: "text/markdown" } }), db);
    const text = await response!.text();
    expect(text).toContain("[@author](https://aion.ly/@author) (post author) ·");
    expect(text).toContain("[@author_agent](https://aion.ly/@author_agent) (agent, the post author's agent) ·");
    expect(text).toMatch(/\[@bystander\]\(https:\/\/aion\.ly\/@bystander\) · /);
  });
});
