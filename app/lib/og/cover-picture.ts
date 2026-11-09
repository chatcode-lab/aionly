import { firstPicture, storedInlineMedia, storedPreview } from "../article";

/** What a post's row says about the pictures it could show on its cover. */
export interface CoverPictureRow {
  kind: string;
  media_type: string | null;
  media_key: string | null;
  thumb_key: string | null;
  inline_media?: string | null;
  card_preview?: string | null;
}

/**
 * The picture a post's cover shows, by its key, or null for none: an
 * uploaded picture itself; a text post's card preview's picture, one of its
 * uploads or a link's snapshot, or else the first picture its text places;
 * anything else, its snapshot or poster. The page and the cover read it
 * here alike, and its key is part of the cover's version, so a cover is
 * never served again once its picture changes (review F130).
 */
export function coverPicture(row: CoverPictureRow): string | null {
  if (row.kind === "upload" && row.media_type === "image") return row.media_key;
  if (row.kind !== "text") return row.thumb_key || null;
  const files = storedInlineMedia(row.inline_media);
  const preview = storedPreview(row.card_preview);
  if (preview && "upload" in preview) {
    const file = files.find((held) => held.key === preview.upload);
    if (file?.type === "image") return file.key;
  }
  if (preview && "link" in preview && row.thumb_key) return row.thumb_key;
  return firstPicture(files)?.key ?? null;
}

/**
 * Whether a post has a cover picture, as coverPicture would find one, in
 * SQL for its row (`post`): 1 or 0. What a digest and the channel prefer
 * between posts with as many points (owner's request, 2026-11-09).
 */
export function coverPictureSql(post: string): string {
  // Malformed JSON, which coverPicture reads as none, would stop the query.
  const json = (column: string, empty: string) => `CASE WHEN json_valid(${post}.${column}) THEN ${post}.${column} ELSE '${empty}' END`;
  return `(CASE
    WHEN ${post}.kind = 'upload' AND ${post}.media_type = 'image' THEN COALESCE(${post}.media_key, '') <> ''
    WHEN ${post}.kind <> 'text' THEN COALESCE(${post}.thumb_key, '') <> ''
    ELSE (json_type(${json("card_preview", "{}")}, '$.link') IS 'text' AND COALESCE(${post}.thumb_key, '') <> '')
      OR EXISTS (SELECT 1 FROM json_each(${json("inline_media", "[]")}) AS file WHERE CASE WHEN file.type = 'object' THEN json_extract(file.value, '$.type') = 'image' AND json_type(file.value, '$.key') = 'text' END)
  END)`;
}
