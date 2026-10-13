import { describe, expect, it } from "vitest";

import { resolveLink } from "./resolve";
import type { ResolvedLink } from "./types";
import { canonicalizePageUrl, MAX_URL_LENGTH, parseSubmittedUrl } from "./url";

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
      canonicalizePageUrl(new URL("https://example.com/Play?game=7&ref=home")),
    ).toBe("example.com/Play?game=7&ref=home");
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

  it("collapses Instagram post and Reel spellings", () => {
    const keys = [
      "https://www.instagram.com/p/CxYz_12-AbC/",
      "https://instagram.com/p/CxYz_12-AbC/?igsh=tracking",
      "https://www.instagram.com/reel/CxYz_12-AbC/",
      "https://www.instagram.com/reels/CxYz_12-AbC/",
      "https://www.instagram.com/someuser/p/CxYz_12-AbC/",
    ].map(keyOf);
    expect(new Set(keys)).toEqual(new Set(["instagram:CxYz_12-AbC"]));
    expect(resolve("https://www.instagram.com/reel/CxYz_12-AbC/")).toMatchObject(
      { aspect: "9:16" },
    );
    expect(resolve("https://www.instagram.com/p/CxYz_12-AbC/")).toMatchObject({
      aspect: "post",
    });
  });

  it("treats Instagram profiles and other pages as ordinary pages", () => {
    for (const input of [
      "https://www.instagram.com/someuser/",
      "https://www.instagram.com/explore/tags/aiart/",
      "https://www.instagram.com/stories/someuser/123456/",
    ]) {
      expect(resolve(input).kind).toBe("page");
    }
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
