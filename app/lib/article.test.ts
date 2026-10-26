import { describe, expect, it } from "vitest";

import { articleKeys, firstPicture, hasStrayUploads, inlineMediaJson, storedInlineMedia } from "./article";
import { parseBlocks, plainLines, plainText } from "./text/markdown";
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
