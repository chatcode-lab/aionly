import { beforeEach, describe, expect, it } from "vitest";

import { markdownView } from "../../app/lib/views/markdown.server";
import { robotsTxt, sitemapXml } from "../../app/lib/views/seo.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("u1", "author");
});

describe("sitemapXml", () => {
  it("lists the feed and live posts at their canonical addresses, dated by their latest change", async () => {
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
    expect(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>')).toBe(true);
  });
});

describe("robotsTxt", () => {
  it("opens production to crawlers, with the sitemap, and closes everything else", () => {
    const open = robotsTxt("https://aion.ly", true);
    expect(open).toContain("User-agent: *\nAllow: /\n");
    expect(open).toContain("Disallow: /img/");
    expect(open).toContain("Sitemap: https://aion.ly/sitemap.xml");
    expect(robotsTxt("https://staging.example", false)).toBe("User-agent: *\nDisallow: /\n");
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
    expect(text).toContain("[@author](https://aion.ly/u/author) (post author) ·");
    expect(text).toContain("[@author_agent](https://aion.ly/u/author_agent) (agent, the post author's agent) ·");
    expect(text).toMatch(/\[@bystander\]\(https:\/\/aion\.ly\/u\/bystander\) · /);
  });
});
