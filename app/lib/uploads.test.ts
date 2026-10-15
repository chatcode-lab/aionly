import { describe, expect, it } from "vitest";

import { sniffMedia, stripJpegMetadata } from "./uploads";

const bytes = (...values: Array<number | string>) =>
  Uint8Array.from(values.flatMap((value) => (typeof value === "string" ? [...value].map((char) => char.charCodeAt(0)) : [value])));

describe("what an upload is", () => {
  it("reads the type from the bytes", () => {
    expect(sniffMedia(bytes(0xff, 0xd8, 0xff, 0xe0))?.contentType).toBe("image/jpeg");
    expect(sniffMedia(bytes("GIF89a"))?.contentType).toBe("image/gif");
    expect(sniffMedia(bytes("RIFF", 0, 0, 0, 0, "WEBP"))?.contentType).toBe("image/webp");
    expect(sniffMedia(bytes("RIFF", 0, 0, 0, 0, "WAVE"))?.media).toBe("audio");
    expect(sniffMedia(bytes("ID3", 4))?.contentType).toBe("audio/mpeg");
    expect(sniffMedia(bytes(0, 0, 0, 0x20, "ftypisom"))?.contentType).toBe("video/mp4");
    expect(sniffMedia(bytes(0, 0, 0, 0x20, "ftypqt  "))?.contentType).toBe("video/quicktime");
    expect(sniffMedia(bytes(0, 0, 0, 0x20, "ftypM4A "))?.media).toBe("audio");
    expect(sniffMedia(bytes(0x1a, 0x45, 0xdf, 0xa3))?.contentType).toBe("video/webm");
  });

  it("refuses what not every browser shows, and anything else", () => {
    expect(sniffMedia(bytes(0, 0, 0, 0x20, "ftypheic"))).toBeNull();
    expect(sniffMedia(bytes("<html>"))).toBeNull();
    expect(sniffMedia(bytes("%PDF-1.7"))).toBeNull();
  });
});

describe("photo metadata", () => {
  it("drops EXIF and comments from a JPEG, and keeps the color profile and the picture", () => {
    const segment = (marker: number, payload: string) => [0xff, marker, 0, payload.length + 2, ...[...payload].map((c) => c.charCodeAt(0))];
    const jpeg = Uint8Array.from([
      0xff, 0xd8,
      ...segment(0xe0, "JFIF"),
      ...segment(0xe1, "Exif GPS 52.5N"),
      ...segment(0xe2, "ICC_PROFILE"),
      ...segment(0xfe, "a comment"),
      0xff, 0xda, 0, 4, 1, 2, 3, 4, 0xff, 0xd9,
    ]);
    const stripped = new TextDecoder("latin1").decode(stripJpegMetadata(jpeg));
    expect(stripped).not.toContain("GPS");
    expect(stripped).not.toContain("a comment");
    expect(stripped).toContain("JFIF");
    expect(stripped).toContain("ICC_PROFILE");
    expect(stripped.endsWith("ÿÙ")).toBe(true);
  });
});
