import { describe, expect, it } from "vitest";

import { clip, HOME_TITLE, pageMeta, PAGES, privatePageMeta, standingPageMeta } from "./meta";

const matches = [{ id: "root", loaderData: { origin: "https://staging.example" } }];
const tag = (meta: ReturnType<typeof pageMeta>, key: string) =>
  meta.find((entry) => (entry as Record<string, string>).property === key || (entry as Record<string, string>).name === key) as
    | { content: string }
    | undefined;

describe("page meta", () => {
  it("names the page, its address, and a large cover, with whole addresses on this host", () => {
    const meta = pageMeta(matches, { title: "A post", description: "What it is.", path: "/p/abc/a-post", image: "/og/p/abc.png?v=1", type: "article" });
    expect(meta).toContainEqual({ title: "A post · aion.ly" });
    expect(meta).toContainEqual({ tagName: "link", rel: "canonical", href: "https://staging.example/p/abc/a-post" });
    expect(tag(meta, "og:title")?.content).toBe("A post");
    expect(tag(meta, "og:type")?.content).toBe("article");
    expect(tag(meta, "og:url")?.content).toBe("https://staging.example/p/abc/a-post");
    expect(tag(meta, "og:image")?.content).toBe("https://staging.example/og/p/abc.png?v=1");
    expect(tag(meta, "og:image:width")?.content).toBe("1200");
    expect(tag(meta, "twitter:card")?.content).toBe("summary_large_image");
    expect(tag(meta, "twitter:image")?.content).toBe("https://staging.example/og/p/abc.png?v=1");
    expect(tag(meta, "robots")).toBeUndefined();
  });

  it("falls back to the site's address and cover", () => {
    const meta = pageMeta([], { title: HOME_TITLE, bare: true, description: "x", path: "/" });
    expect(meta).toContainEqual({ title: HOME_TITLE });
    expect(tag(meta, "og:image")?.content).toBe("https://aion.ly/og/site.png");
  });

  it("keeps private pages out of search engines", () => {
    expect(tag(privatePageMeta(matches, "Settings", "/settings"), "robots")?.content).toBe("noindex");
  });

  it("gives each standing page its own cover", () => {
    for (const key of Object.keys(PAGES) as Array<keyof typeof PAGES>) {
      const meta = standingPageMeta(matches, key);
      expect(tag(meta, "og:image")?.content).toBe(`https://staging.example/og/page/${key}.png`);
      expect(tag(meta, "description")?.content.length).toBeLessThanOrEqual(160);
    }
  });

  it("clips descriptions at a word", () => {
    expect(clip("short")).toBe("short");
    const long = clip("word ".repeat(60));
    expect(long.length).toBeLessThanOrEqual(160);
    expect(long.endsWith("word…")).toBe(true);
  });
});
