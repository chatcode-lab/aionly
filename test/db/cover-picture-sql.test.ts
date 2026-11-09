import { describe, expect, it } from "vitest";

import { coverPicture, type CoverPictureRow, coverPictureSql } from "../../app/lib/og/cover-picture";
import { db } from "./fixtures";

const key = (name: string, extension = "jpg") => `${name.padEnd(24, "x")}.${extension}`;
const files = (...list: Array<{ name: string; type: string }>) =>
  JSON.stringify(list.map((file) => ({ key: key(file.name, file.type === "image" ? "jpg" : "mp4"), type: file.type, width: 10, height: 10 })));
const link = JSON.stringify({ link: "https://example.com/page" });

const ROWS: Array<[string, CoverPictureRow]> = [
  ["an uploaded picture", { kind: "upload", media_type: "image", media_key: key("picture"), thumb_key: null }],
  ["an uploaded video's poster", { kind: "upload", media_type: "video", media_key: key("video", "mp4"), thumb_key: key("poster") }],
  ["a song with no picture", { kind: "upload", media_type: "audio", media_key: key("song", "mp3"), thumb_key: null }],
  ["a link's snapshot", { kind: "link", media_type: null, media_key: null, thumb_key: key("snapshot") }],
  ["a link without one", { kind: "link", media_type: null, media_key: null, thumb_key: null }],
  ["a link with an empty one", { kind: "link", media_type: null, media_key: null, thumb_key: "" }],
  ["an article's picture", { kind: "text", media_type: null, media_key: null, thumb_key: null, inline_media: files({ name: "a", type: "image" }) }],
  ["an article's video alone", { kind: "text", media_type: null, media_key: null, thumb_key: null, inline_media: files({ name: "v", type: "video" }) }],
  ["an article's picture after its video", { kind: "text", media_type: null, media_key: null, thumb_key: null, inline_media: files({ name: "v", type: "video" }, { name: "a", type: "image" }) }],
  ["an article's link preview", { kind: "text", media_type: null, media_key: null, thumb_key: key("snapshot"), card_preview: link }],
  ["an article's link preview without a picture", { kind: "text", media_type: null, media_key: null, thumb_key: null, card_preview: link }],
  ["an article's snapshot kept with no preview", { kind: "text", media_type: null, media_key: null, thumb_key: key("snapshot"), card_preview: null }],
  ["an article with nothing", { kind: "text", media_type: null, media_key: null, thumb_key: null }],
  ["malformed media", { kind: "text", media_type: null, media_key: null, thumb_key: key("snapshot"), inline_media: "not json", card_preview: "{" }],
  ["media that is not a list of files", { kind: "text", media_type: null, media_key: null, thumb_key: null, inline_media: '["x", 3, {"type": "image"}]' }],
];

describe("coverPictureSql", () => {
  it("finds a cover picture where coverPicture does, and none where it finds none", async () => {
    for (const [name, row] of ROWS) {
      const found = await db
        .prepare(
          `WITH post (kind, media_type, media_key, thumb_key, inline_media, card_preview) AS (VALUES (?1, ?2, ?3, ?4, ?5, ?6))
           SELECT ${coverPictureSql("post")} AS pictured FROM post`,
        )
        .bind(row.kind, row.media_type, row.media_key, row.thumb_key, row.inline_media ?? null, row.card_preview ?? null)
        .first<{ pictured: number }>();
      expect([name, found?.pictured]).toEqual([name, coverPicture(row) === null ? 0 : 1]);
    }
  });
});
