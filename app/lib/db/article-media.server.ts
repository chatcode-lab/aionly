import {
  ARTICLE_BYTES,
  ARTICLE_MEDIA_MAX,
  ARTICLE_SYNTAX,
  articleKeys,
  hasStrayUploads,
  type InlineMedia,
  inlineMediaJson,
  storedInlineMedia,
} from "../article";
import { mediaTypeOf } from "../uploads";

/**
 * An article's files (docs/articles.md): the uploads its text places, which
 * it holds as its own. Each is its author's upload, sent and not yet used,
 * or one the post or draft being written already holds; never another
 * post's, nor anything from elsewhere. Read here, and checked again inside
 * the write that claims them, so a file used or let go meanwhile leaves the
 * post as it was.
 */

export type InlineMediaCheck = { ok: true; json: string | null } | { ok: false; problem: string };

/**
 * The files an article's text places, as it will hold them, or what is
 * wrong, in words for its description. `kept` are the keys the post or
 * draft being written holds already. Text that is not an article's may
 * place none.
 */
export async function inlineMediaFor(
  db: D1Database,
  input: { authorId: string; text: string; kept: readonly string[]; article: boolean },
): Promise<InlineMediaCheck> {
  const keys = articleKeys(input.text);
  if (hasStrayUploads(input.text)) {
    return { ok: false, problem: `Put each upload on a line of its own, as ${ARTICLE_SYNTAX}; in a sentence or a list it shows only as words.` };
  }
  if (keys.length === 0) return { ok: true, json: null };
  if (!input.article) return { ok: false, problem: "Only a text post places uploads in its text." };
  if (keys.length > ARTICLE_MEDIA_MAX) return { ok: false, problem: `A text post shows at most ${ARTICLE_MEDIA_MAX} uploads.` };

  const { results } = await db
    .prepare(
      `SELECT key, state, content_type, bytes, width, height FROM images
       WHERE owner_id = ?1 AND kind = 'media' AND key IN (SELECT value FROM json_each(?2))`,
    )
    .bind(input.authorId, JSON.stringify(keys))
    .all<{ key: string; state: string; content_type: string; bytes: number; width: number | null; height: number | null }>();
  const rows = new Map(results.map((row) => [row.key, row]));
  const usable = (key: string) => {
    const row = rows.get(key);
    return row !== undefined && mediaTypeOf(row.content_type) !== null && (row.state === "pending" || input.kept.includes(key));
  };
  const missing = keys.filter((key) => !usable(key));
  if (missing.length > 0) {
    return {
      ok: false,
      problem: `${missing.join(", ")} ${missing.length === 1 ? "is not an upload" : "are not uploads"} of yours waiting to be used: send each file first, then place it; an upload keeps for a day.`,
    };
  }
  if (keys.reduce((sum, key) => sum + rows.get(key)!.bytes, 0) > ARTICLE_BYTES) {
    return { ok: false, problem: `The uploads a text post shows hold at most ${ARTICLE_BYTES / 1024 / 1024} MB together.` };
  }
  const media: InlineMedia[] = keys.map((key) => {
    const row = rows.get(key)!;
    return { key, type: mediaTypeOf(row.content_type)!, width: row.width, height: row.height };
  });
  return { ok: true, json: inlineMediaJson(media) };
}

/** The keys of stored files, as JSON or as a list. */
export function inlineKeys(json: string | null | undefined): string[] {
  return storedInlineMedia(json).map((file) => file.key);
}

/**
 * SQL: every file of the article's files `?{json}` (null for none) is the
 * author `?{author}`'s upload, pending, or one of `kept`, a SQL list of the
 * keys the post or draft being written holds.
 */
export function inlineMediaHolds(json: number, author: number, kept: string): string {
  return `(?${json} IS NULL OR (SELECT COUNT(*) FROM json_each(?${json}) AS placed WHERE EXISTS (
    SELECT 1 FROM images WHERE key = json_extract(placed.value, '$.key') AND owner_id = ?${author} AND kind = 'media'
      AND (state = 'pending' OR key IN (${kept})))) = json_array_length(?${json}))`;
}

/** SQL: the keys of the files a row's JSON column `{column}` lists. */
export function inlineKeysSql(column: string): string {
  return `SELECT json_extract(placed.value, '$.key') FROM json_each(${column}) AS placed`;
}
