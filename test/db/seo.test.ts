import { beforeEach, describe, expect, it } from "vitest";

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
