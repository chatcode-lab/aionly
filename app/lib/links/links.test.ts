import { describe, expect, it } from "vitest";

import { mediaUrl, resolveLink } from "./resolve";
import type { ResolvedLink } from "./types";
import { canonicalizePageUrl, cleanPageUrl, isSamePage, MAX_URL_LENGTH, parseSubmittedUrl } from "./url";

function resolve(input: string): ResolvedLink {
  const parsed = parseSubmittedUrl(input);
  if (!parsed.ok) throw new Error(`rejected ${input}: ${parsed.reason}`);
  return resolveLink(parsed.url);
}

function keyOf(input: string): string {
  const link = resolve(input);
  if (link.kind === "short") throw new Error(`short link: ${input}`);
  return link.canonicalKey;
}

describe("parseSubmittedUrl", () => {
  it("accepts a plain https URL and trims whitespace", () => {
    const parsed = parseSubmittedUrl("  https://example.com/a?b=1  ");
    expect(parsed).toMatchObject({ ok: true });
    if (parsed.ok) expect(parsed.url.href).toBe("https://example.com/a?b=1");
  });

  it("accepts the default port, a root dot, and internationalized names", () => {
    expect(parseSubmittedUrl("https://example.com:443/").ok).toBe(true);
    expect(parseSubmittedUrl("https://example.com./").ok).toBe(true);
    expect(parseSubmittedUrl("https://пример.рф/").ok).toBe(true);
  });

  it.each([
    ["", "empty"],
    ["   ", "empty"],
    [`https://example.com/${"a".repeat(MAX_URL_LENGTH)}`, "too_long"],
    ["not a url", "invalid"],
    ["http://example.com/", "not_https"],
    ["javascript:alert(1)", "not_https"],
    ["data:text/html,<script>alert(1)</script>", "not_https"],
    ["https://user:pass@example.com/", "credentials"],
    ["https://user@example.com/", "credentials"],
    ["https://example.com:8443/", "port"],
  ])("rejects %j as %s", (input, reason) => {
    expect(parseSubmittedUrl(input)).toEqual({ ok: false, reason });
  });

  it.each([
    "https://localhost/",
    "https://intranet/",
    "https://127.0.0.1/",
    "https://0x7f.0.0.1/",
    "https://2130706433/",
    "https://10.0.0.5/",
    "https://[::1]/",
    "https://[fd00::1]/",
    "https://printer.local/",
    "https://db.internal/",
    "https://example.test/",
    "https://service.localhost/",
  ])("rejects the non-public host in %s", (input) => {
    expect(parseSubmittedUrl(input)).toEqual({
      ok: false,
      reason: "host_not_public",
    });
  });

  it("rejects the site's own hostnames and their subdomains", () => {
    const options = { ownHosts: ["aion.ly"] };
    for (const input of [
      "https://aion.ly/p/abc",
      "https://AION.LY/",
      "https://dev.aion.ly/",
    ]) {
      expect(parseSubmittedUrl(input, options)).toEqual({
        ok: false,
        reason: "own_host",
      });
    }
    expect(parseSubmittedUrl("https://notaion.ly/", options).ok).toBe(true);
  });
});

describe("canonicalizePageUrl", () => {
  it("drops www, the fragment, tracking parameters, and a trailing slash", () => {
    const url = new URL(
      "https://www.Example.com/Path/?utm_source=x&b=2&fbclid=9&a=1#frag",
    );
    expect(canonicalizePageUrl(url)).toBe("example.com/Path?a=1&b=2");
  });

  it("reduces a bare origin to its host", () => {
    expect(canonicalizePageUrl(new URL("https://example.com/"))).toBe(
      "example.com",
    );
  });

  it("keeps meaningful query parameters and path case", () => {
    expect(
      canonicalizePageUrl(new URL("https://example.com/Play?game=7&page=2")),
    ).toBe("example.com/Play?game=7&page=2");
  });

  it("drops referral, affiliate, and analytics parameters", () => {
    const url = new URL(
      "https://example.com/tool?id=4&ref=producthunt&affid=77&refid=x&si=abc&pk_campaign=a&mtm_source=b&hsa_ad=1&_gl=z&srsltid=q",
    );
    expect(canonicalizePageUrl(url)).toBe("example.com/tool?id=4");
    expect(cleanPageUrl(url)).toBe("https://example.com/tool?id=4");
  });
});

describe("isSamePage", () => {
  const submitted = new URL("https://example.com/post/42?source=rss&campaign=x");
  it("accepts the same page, www and a trailing slash aside", () => {
    expect(isSamePage(new URL("https://www.example.com/post/42/"), submitted)).toBe(true);
    expect(isSamePage(new URL("https://example.com/post/42?lang=en"), submitted)).toBe(true);
  });
  it("ignores a canonical that points elsewhere", () => {
    expect(isSamePage(new URL("https://example.com/"), submitted)).toBe(false);
    expect(isSamePage(new URL("https://other.example/post/42"), submitted)).toBe(false);
    expect(isSamePage(new URL("http://example.com/post/42"), submitted)).toBe(false);
  });
});

describe("resolveLink", () => {
  it("collapses every YouTube spelling of one video", () => {
    const keys = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtube.com/watch?v=dQw4w9WgXcQ&t=42s&list=PL123",
      "https://m.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://music.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://youtu.be/dQw4w9WgXcQ?si=tracking",
      "https://www.youtube.com/shorts/dQw4w9WgXcQ",
      "https://www.youtube.com/embed/dQw4w9WgXcQ",
      "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ",
      "https://www.youtube.com/live/dQw4w9WgXcQ",
    ].map(keyOf);
    expect(new Set(keys)).toEqual(new Set(["youtube:dQw4w9WgXcQ"]));
  });

  it("marks Shorts as vertical and other videos as widescreen", () => {
    expect(resolve("https://www.youtube.com/shorts/dQw4w9WgXcQ")).toMatchObject(
      { provider: "youtube", aspect: "9:16", controlled: true },
    );
    expect(resolve("https://youtu.be/dQw4w9WgXcQ")).toMatchObject({
      provider: "youtube",
      aspect: "16:9",
      controlled: true,
    });
  });

  it("treats YouTube pages that are not one video as ordinary pages", () => {
    for (const input of [
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/playlist?list=PL123",
      "https://www.youtube.com/watch?v=tooshort",
      "https://www.youtube.com/watch",
    ]) {
      expect(resolve(input).kind).toBe("page");
    }
  });

  it("resolves TikTok videos and photo posts by ID", () => {
    expect(
      resolve("https://www.tiktok.com/@scout2015/video/6718335390845095173?lang=en"),
    ).toMatchObject({
      kind: "media",
      canonicalKey: "tiktok:6718335390845095173",
      aspect: "9:16",
      controlled: true,
    });
    expect(keyOf("https://www.tiktok.com/@someone/photo/7312345678901234567")).toBe(
      "tiktok:7312345678901234567",
    );
    expect(keyOf("https://m.tiktok.com/v/6718335390845095173.html")).toBe(
      "tiktok:6718335390845095173",
    );
    expect(keyOf("https://www.tiktok.com/player/v1/6718335390845095173")).toBe(
      "tiktok:6718335390845095173",
    );
  });

  it("flags TikTok short links for server-side resolution", () => {
    for (const input of [
      "https://vm.tiktok.com/ZMabcdefg/",
      "https://vt.tiktok.com/ZSabcdefg/",
      "https://www.tiktok.com/t/ZTabcdefg/",
    ]) {
      expect(resolve(input)).toMatchObject({ kind: "short", provider: "tiktok" });
    }
    expect(resolve("https://www.tiktok.com/@scout2015").kind).toBe("page");
  });

  it("resolves Suno songs and flags share links", () => {
    const id = "1b2c3d4e-5f60-4a7b-8c9d-0e1f2a3b4c5d";
    expect(resolve(`https://suno.com/song/${id.toUpperCase()}`)).toMatchObject({
      kind: "media",
      canonicalKey: `suno:${id}`,
      aspect: "audio",
      controlled: false,
    });
    expect(keyOf(`https://app.suno.ai/song/${id}/`)).toBe(`suno:${id}`);
    expect(resolve("https://suno.com/s/AbCdEf123456")).toMatchObject({
      kind: "short",
      provider: "suno",
    });
    expect(resolve("https://suno.com/@artist").kind).toBe("page");
  });

  it("resolves SoundCloud tracks and playlists, and flags share links", () => {
    expect(resolve("https://soundcloud.com/Forss/Flickermood?si=abc&utm_source=clipboard")).toMatchObject({
      kind: "media",
      provider: "soundcloud",
      id: "forss/flickermood",
      canonicalKey: "soundcloud:forss/flickermood",
      aspect: "audio",
      controlled: false,
    });
    expect(keyOf("https://m.soundcloud.com/forss/flickermood")).toBe("soundcloud:forss/flickermood");
    // A track opened from a playlist is the track.
    expect(keyOf("https://soundcloud.com/forss/flickermood?in=forss/sets/soulhack")).toBe("soundcloud:forss/flickermood");
    expect(keyOf("https://soundcloud.com/auggie-490304907/sets/ai-baroque-music-quiz")).toBe(
      "soundcloud:auggie-490304907/sets/ai-baroque-music-quiz",
    );
    expect(resolve("https://on.soundcloud.com/AbCdEf123")).toMatchObject({ kind: "short", provider: "soundcloud" });
    // Accounts, their pages, the site's own, and private links stay pages.
    for (const page of [
      "https://soundcloud.com/forss",
      "https://soundcloud.com/forss/tracks",
      "https://soundcloud.com/forss/sets",
      "https://soundcloud.com/discover/sets/charts-top",
      "https://soundcloud.com/search/sounds?q=ai",
      "https://soundcloud.com/forss/flickermood/s-AbCdEf",
      "https://soundcloud.com/forss/sets/soulhack/s-AbCdEf",
      "https://soundcloud.com/forss/flickermood/recommended",
    ]) {
      expect(resolve(page).kind, page).toBe("page");
    }
  });

  it("collapses every Reddit spelling of one post", () => {
    const keys = [
      "https://www.reddit.com/r/place/comments/tqbguc/412022/",
      "https://reddit.com/r/place/comments/tqbguc",
      "https://old.reddit.com/r/place/comments/tqbguc/412022/",
      "https://new.reddit.com/r/place/comments/TQBGUC/412022/?utm_source=share",
      "https://www.reddit.com/r/place/comments/tqbguc/412022/i2gflrf/",
    ].map(keyOf);
    expect(new Set(keys)).toEqual(new Set(["reddit:tqbguc"]));
  });

  it("keeps the community a Reddit frame needs", () => {
    expect(
      resolve("https://www.reddit.com/r/place/comments/tqbguc/412022/"),
    ).toEqual({
      kind: "media",
      provider: "reddit",
      id: "tqbguc",
      canonicalKey: "reddit:tqbguc",
      aspect: "post",
      controlled: false,
      embedPath: "r/place/comments/tqbguc",
    });
    expect(
      resolve("https://www.reddit.com/u/some-user/comments/abc123/a_title/"),
    ).toMatchObject({ embedPath: "user/some-user/comments/abc123" });
  });

  it("flags Reddit links that omit the community for resolution", () => {
    for (const input of [
      "https://redd.it/tqbguc",
      "https://www.reddit.com/comments/tqbguc",
      "https://www.reddit.com/gallery/tqbguc",
      "https://www.reddit.com/r/place/s/AbCdEf1234",
    ]) {
      expect(resolve(input)).toMatchObject({ kind: "short", provider: "reddit" });
    }
  });

  it("treats Reddit pages that are not one post as ordinary pages", () => {
    for (const input of [
      "https://www.reddit.com/r/place/",
      "https://www.reddit.com/user/someone/",
      "https://www.reddit.com/r/place/comments/",
      "https://www.reddit.com/r/place/comments/not_an_id!/x/",
      "https://www.reddit.com/r/a/comments/tqbguc/x/",
    ]) {
      expect(resolve(input).kind).toBe("page");
    }
  });

  it("collapses every Telegram spelling of one channel post", () => {
    const keys = [
      "https://t.me/telegram/83",
      "https://t.me/Telegram/83",
      "https://t.me/s/telegram/83",
      "https://telegram.me/telegram/83",
      "https://t.me/telegram/83?single",
    ].map(keyOf);
    expect(new Set(keys)).toEqual(new Set(["telegram:telegram/83"]));
    expect(resolve("https://t.me/telegram/83")).toEqual({
      kind: "media",
      provider: "telegram",
      id: "telegram/83",
      canonicalKey: "telegram:telegram/83",
      aspect: "post",
      controlled: false,
    });
  });

  it("treats Telegram links that cannot be embedded as ordinary pages", () => {
    for (const input of [
      "https://t.me/telegram",
      "https://t.me/c/1234567890/42",
      "https://t.me/somegroup/12/345",
      "https://t.me/+AbCdEfGhIjK",
      "https://t.me/joinchat/AbCdEfGhIjK",
      "https://t.me/telegram/not-a-number",
      "https://t.me/abc/83",
    ]) {
      expect(resolve(input).kind).toBe("page");
    }
  });

  it("no longer treats Instagram as a provider", () => {
    expect(resolve("https://www.instagram.com/p/CxYz_12-AbC/")).toMatchObject({
      kind: "page",
      host: "instagram.com",
    });
  });

  it("normalizes X and Twitter posts by post ID", () => {
    const keys = [
      "https://x.com/jack/status/20",
      "https://twitter.com/jack/status/20",
      "https://www.twitter.com/jack/status/20?s=20&t=abc",
      "https://mobile.twitter.com/jack/status/20",
      "https://x.com/jack/status/20/photo/1",
      "https://x.com/i/status/20",
      "https://twitter.com/i/web/status/20",
      "https://twitter.com/jack/statuses/20",
    ].map(keyOf);
    expect(new Set(keys)).toEqual(new Set(["x:20"]));
  });

  it("treats X profiles and malformed status URLs as ordinary pages", () => {
    for (const input of [
      "https://x.com/jack",
      "https://x.com/status/20",
      "https://x.com/jack/status/not-a-number",
      "https://x.com/a/b/c/status/20",
    ]) {
      expect(resolve(input).kind).toBe("page");
    }
  });

  it("keys other URLs by their canonical page form", () => {
    expect(resolve("https://www.Example.com/game/?utm_campaign=x#play")).toEqual({
      kind: "page",
      canonicalKey: "url:example.com/game",
      url: "https://www.example.com/game/?utm_campaign=x",
      host: "example.com",
    });
  });
});

describe("stored addresses", () => {
  const stored = (input: string) => {
    const url = new URL(input);
    const link = resolveLink(url);
    if (link.kind === "short") throw new Error("short");
    return link.kind === "media" ? mediaUrl(link, url) : cleanPageUrl(url);
  };

  it("stores a provider's plain address, whatever the spelling", () => {
    expect(stored("https://youtu.be/dQw4w9WgXcQ?si=abc&t=10")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(stored("https://m.youtube.com/watch?v=dQw4w9WgXcQ&feature=share")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
    expect(stored("https://www.youtube.com/shorts/jNQXAC9IVRw?feature=share")).toBe("https://www.youtube.com/shorts/jNQXAC9IVRw");
    expect(stored("https://suno.com/song/CF674415-DEBB-498C-AA29-37A58A28D8E9?sh=xyz")).toBe("https://suno.com/song/cf674415-debb-498c-aa29-37a58a28d8e9");
    expect(stored("https://m.soundcloud.com/Forss/Flickermood?si=abc#t=1:00")).toBe("https://soundcloud.com/forss/flickermood");
    expect(stored("https://old.reddit.com/r/place/comments/tqbguc/412022/abc123/?utm_source=share")).toBe("https://www.reddit.com/r/place/comments/tqbguc/");
    expect(stored("https://t.me/s/Telegram/83?single")).toBe("https://t.me/telegram/83");
    expect(stored("https://twitter.com/jack/status/20?s=20&t=abc")).toBe("https://twitter.com/jack/status/20");
    expect(stored("https://www.tiktok.com/@scout2015/video/6718335390845095173?is_from_webapp=1")).toBe("https://www.tiktok.com/@scout2015/video/6718335390845095173");
  });

  it("keeps a page's own query, minus tracking and the fragment", () => {
    expect(stored("https://example.com/a?page=2&utm_source=x&fbclid=y#top")).toBe("https://example.com/a?page=2");
  });
});
