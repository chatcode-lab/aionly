import { describe, expect, it } from "vitest";

import { articleKeys, firstPicture, hasStrayUploads, inlineMediaJson, previewCandidates, previewEmbedKey, previewPlaced, storedInlineMedia, storedPreview } from "./article";
import { articleEmbeds, articleLines, parseArticle, parseBlocks, plainLines, plainText, TEXT_EMBEDS_MAX } from "./text/markdown";
import { pictureSize } from "./uploads";

const key = (n: number, extension = "png") => `${String(n).padStart(24, "a")}.${extension}`;

describe("an article's text", () => {
  it("shows an upload on a line of its own, with its words and an optional caption, between paragraphs", () => {
    const text = `First.\n![A street in the rain](upload:${key(1)})\nThen ![not this](upload:${key(2)}) in a sentence.\n\n![](upload:${key(3, "mp4")} "Four seconds")`;
    expect(parseBlocks(text)).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "First." }] },
      { type: "media", key: key(1), alt: "A street in the rain", caption: null },
      {
        type: "paragraph",
        children: [
          { type: "text", text: "Then " },
          { type: "link", href: `upload:${key(2)}`, children: [{ type: "text", text: "not this" }] },
          { type: "text", text: " in a sentence." },
        ],
      },
      { type: "media", key: key(3, "mp4"), alt: "", caption: "Four seconds" },
    ]);
  });

  it("names its uploads once each, in the order it first shows them, quotes included", () => {
    expect(articleKeys(`![a](upload:${key(2)})\n\n> ![b](upload:${key(1)})\n\n![c](upload:${key(2)})`)).toEqual([key(2), key(1)]);
    expect(articleKeys("No uploads, just ![a picture](https://example.com/a.png).")).toEqual([]);
  });

  it("finds an upload placed where it would show only as words", () => {
    expect(hasStrayUploads(`![a](upload:${key(1)})`)).toBe(false);
    expect(hasStrayUploads(`See ![a](upload:${key(1)}) here.`)).toBe(true);
    expect(hasStrayUploads(`- ![a](upload:${key(1)})`)).toBe(true);
    // A key that is not one stays as words too.
    expect(hasStrayUploads("![a](upload:../etc/passwd)")).toBe(true);
    expect(hasStrayUploads("![a](https://example.com/a.png)")).toBe(false);
  });

  it("leaves its uploads out of every summary", () => {
    const text = `Before.\n\n![A street](upload:${key(1)} "Caption")\n\nAfter.`;
    expect(plainLines(text)).toBe("Before.\nAfter.");
    expect(plainText(text)).toBe("Before. After.");
  });
});

describe("a provider link on a line of its own in an article (owner's request, 2026-10-26)", () => {
  const watch = "https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=10s";
  const video = { type: "embed", url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", key: "youtube:dQw4w9WgXcQ", provider: "youtube", aspect: "16:9" };

  it("shows as its player, at its plain address, between the lines around it, in a quote too", () => {
    expect(parseArticle(`Watch this:\n${watch}\nThen this.\n\n> https://www.tiktok.com/@scout/video/7301234567890123456`)).toEqual([
      { type: "paragraph", children: [{ type: "text", text: "Watch this:" }] },
      { ...video, index: 0 },
      { type: "paragraph", children: [{ type: "text", text: "Then this." }] },
      {
        type: "quote",
        children: [{ type: "embed", url: "https://www.tiktok.com/@scout/video/7301234567890123456", key: "tiktok:7301234567890123456", provider: "tiktok", aspect: "9:16", index: 1 }],
      },
    ]);
    expect(articleEmbeds("https://youtu.be/dQw4w9WgXcQ\nhttps://www.youtube.com/shorts/dQw4w9WgXcQ").map((embed) => [embed.key, embed.aspect])).toEqual([
      ["youtube:dQw4w9WgXcQ", "16:9"],
      ["youtube:dQw4w9WgXcQ", "9:16"],
    ]);
  });

  it("stays a link with words around it, in a list, as a short link or a page, without https, or with a full stop after it", () => {
    for (const text of [
      `See ${watch} here.`,
      `- ${watch}`,
      "https://vm.tiktok.com/ZMabc123/",
      "https://redd.it/1abcde",
      "https://example.com/page",
      "http://www.youtube.com/watch?v=dQw4w9WgXcQ",
      `${watch}.`,
      `[the video](${watch})`,
    ]) {
      expect(articleEmbeds(text), text).toEqual([]);
    }
  });

  it("shows at most so many, the rest staying links, and only in an article", () => {
    const many = Array.from({ length: TEXT_EMBEDS_MAX + 2 }, (_, n) => `https://x.com/someone/status/18500000000000000${String(n).padStart(2, "0")}`).join("\n");
    expect(articleEmbeds(many).map((embed) => embed.index)).toEqual(Array.from({ length: TEXT_EMBEDS_MAX }, (_, n) => n));
    expect(new Set(articleEmbeds(many).map((embed) => embed.key)).size).toBe(TEXT_EMBEDS_MAX);
    const last = parseArticle(many).at(-1)!;
    expect(last.type).toBe("paragraph");
    // A comment or a link post's text keeps it a link.
    expect(parseBlocks(watch)).toEqual([{ type: "paragraph", children: [{ type: "url", href: watch }] }]);
  });

  it("leaves the excerpt, and names the media its card preview plays", () => {
    expect(articleLines(`Before.\n${watch}\nAfter, at ${watch}`)).toBe(`Before.\nAfter, at ${watch}`);
    expect(plainLines(`Before.\n${watch}`)).toBe(`Before.\n${watch}`);
    expect(previewEmbedKey("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toBe("youtube:dQw4w9WgXcQ");
    expect(previewEmbedKey("https://example.com/page")).toBeNull();
    expect(previewEmbedKey(undefined)).toBeNull();
  });

  it("takes its card preview's place on the post's page when the text shows the same media, in any spelling", () => {
    const preview = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
    expect(previewPlaced("Intro.\nhttps://youtu.be/dQw4w9WgXcQ", preview)).toBe(true);
    expect(previewPlaced(`Watch ${preview} now.`, preview)).toBe(false);
    expect(previewPlaced("https://www.youtube.com/watch?v=aaaaaaaaaaa", preview)).toBe(false);
    expect(previewPlaced("https://example.com/page", "https://example.com/page")).toBe(false);
  });
});

describe("what a text post's card could preview", () => {
  it("is its uploads and outside links in the order its text gives them, lists and quotes included", () => {
    const text = [
      "Write to [us](mailto:hey@aion.ly), or see `https://example.com/code`.",
      "",
      "> A quote linking [the paper](https://arxiv.org/abs/1706.03762).",
      "",
      `![The still](upload:${key(1)})`,
      "",
      "- A list item with https://example.com/listed and **[bold](https://example.com/bold)**",
    ].join("\n");
    expect(previewCandidates(text)).toEqual([
      { type: "link", url: "https://arxiv.org/abs/1706.03762" },
      { type: "upload", key: key(1), alt: "The still" },
      { type: "link", url: "https://example.com/listed" },
      { type: "link", url: "https://example.com/bold" },
    ]);
    expect(previewCandidates("Only words here.")).toEqual([]);
  });

  it("reads back as stored, and nothing that is not a preview", () => {
    expect(storedPreview(JSON.stringify({ upload: key(1), alt: "The still" }))).toEqual({ upload: key(1), alt: "The still" });
    expect(storedPreview(JSON.stringify({ link: "https://youtube.com/watch?v=x", provider: "youtube", aspect: "16:9", title: null }))).toEqual({
      link: "https://youtube.com/watch?v=x",
      provider: "youtube",
      aspect: "16:9",
      title: null,
    });
    expect(storedPreview(JSON.stringify({ link: "javascript:alert(1)" }))).toBeNull();
    expect(storedPreview(JSON.stringify({ upload: "../x" }))).toBeNull();
    expect(storedPreview(null)).toBeNull();
    expect(storedPreview("not json")).toBeNull();
  });
});

describe("an article's stored files", () => {
  it("read back as written, and nothing that is not one", () => {
    const files = [
      { key: key(1), type: "image" as const, width: 1600, height: 900 },
      { key: key(2, "mp3"), type: "audio" as const, width: null, height: null },
    ];
    expect(storedInlineMedia(inlineMediaJson(files))).toEqual(files);
    expect(inlineMediaJson([])).toBeNull();
    expect(storedInlineMedia(null)).toEqual([]);
    expect(storedInlineMedia("not json")).toEqual([]);
    expect(storedInlineMedia(JSON.stringify([{ key: "../x", type: "image" }, { key: key(3), type: "font" }]))).toEqual([]);
    expect(firstPicture(files)).toEqual(files[0]);
    expect(firstPicture([files[1]!])).toBeNull();
  });
});

describe("a picture's size, read from its bytes", () => {
  const bytes = (...parts: Array<number[] | string>) =>
    Uint8Array.from(parts.flatMap((part) => (typeof part === "string" ? [...part].map((char) => char.charCodeAt(0)) : part)));
  const u32be = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  const u16le = (n: number) => [n & 255, (n >>> 8) & 255];
  const u24le = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255];

  it("reads PNG, GIF, JPEG, WebP, and AVIF headers", () => {
    expect(pictureSize(bytes([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], u32be(13), "IHDR", u32be(1600), u32be(900)))).toEqual({ width: 1600, height: 900 });
    expect(pictureSize(bytes("GIF89a", u16le(320), u16le(240)))).toEqual({ width: 320, height: 240 });
    // A JPEG: an application segment, then a baseline frame of 900 by 1600.
    expect(
      pictureSize(bytes([0xff, 0xd8], [0xff, 0xe0, 0, 4, 1, 2], [0xff, 0xc0, 0, 17, 8], [0x06, 0x40], [0x03, 0x84], [3, 1, 0x22, 0])),
    ).toEqual({ width: 900, height: 1600 });
    const webp = (chunk: string, ...rest: number[][]) => bytes("RIFF", [0, 0, 0, 0], "WEBP", chunk, ...rest);
    expect(pictureSize(webp("VP8 ", [0, 0, 0, 0], [0, 0, 0, 0x9d, 0x01, 0x2a], u16le(640), u16le(480)))).toEqual({ width: 640, height: 480 });
    // Lossless: 14 bits each, less one, after a signature byte.
    const bits = (640 - 1) | ((480 - 1) << 14);
    expect(pictureSize(webp("VP8L", [0, 0, 0, 0], [0x2f], [bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255]))).toEqual({
      width: 640,
      height: 480,
    });
    expect(pictureSize(webp("VP8X", [0, 0, 0, 0], [0, 0, 0, 0], u24le(1999), u24le(999)))).toEqual({ width: 2000, height: 1000 });
    expect(pictureSize(bytes(u32be(28), "ftypavif", [0, 0, 0, 0], u32be(20), "ispe", [0, 0, 0, 0], u32be(1024), u32be(768)))).toEqual({
      width: 1024,
      height: 768,
    });
  });

  it("is null for what it cannot read, and for anything that is not a picture", () => {
    expect(pictureSize(bytes([0xff, 0xd8, 0xff, 0xda, 0, 4]))).toBeNull();
    expect(pictureSize(bytes("GIF89a", u16le(0), u16le(10)))).toBeNull();
    expect(pictureSize(bytes(u32be(32), "ftypisom", new Array(40).fill(1)))).toBeNull();
  });
});
