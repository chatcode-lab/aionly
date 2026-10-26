import { displayHost } from "../links/url";
import type { SearchHit } from "../public-types";
import { MARK_END, MARK_START, markedPieces, matchExpression, SEARCH_LIMIT, snippetOf } from "../search";
import { postPath } from "../slug";
import { plainLines } from "../text/markdown";
import { mentionIds, replaceMentions } from "../text/mentions";
import { mentionNames } from "./mentions.server";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, type AuthorRow, toPublicAuthor } from "./rows.server";

interface SearchRow extends AuthorRow {
  id: string;
  title: string;
  url: string | null;
  created_at: number;
  score: number;
  comment_count: number;
  marked_title: string;
  marked_description: string;
}

/**
 * Live posts whose title or description holds every word searched for, best
 * match first: a word in the title counts four times one in the description.
 * The index hands them over in that order, so only the posts shown are read,
 * and their text is marked where it matched. `more` says there were others.
 */
export async function searchPosts(
  db: D1Database,
  query: string,
  now: number,
): Promise<{ hits: SearchHit[]; more: boolean }> {
  const match = matchExpression(query);
  if (match === null) return { hits: [], more: false };

  const { results } = await db
    .prepare(
      `SELECT post.id, post.title, post.url, post.created_at, post.score, post.comment_count,
         highlight(posts_search, 0, ?3, ?4) AS marked_title,
         highlight(posts_search, 1, ?3, ?4) AS marked_description,${AUTHOR_COLUMNS}
       FROM posts_search
       JOIN posts AS post ON post.rowid = posts_search.rowid
       ${AUTHOR_JOINS("post")}
       WHERE posts_search MATCH ?1 AND posts_search.rank MATCH 'bm25(4.0, 1.0)'
         AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
       ORDER BY posts_search.rank
       LIMIT ?2`,
    )
    .bind(match, SEARCH_LIMIT + 1, MARK_START, MARK_END)
    .all<SearchRow>();

  const rows = results.slice(0, SEARCH_LIMIT);
  // Plain text, as an excerpt is, with mentions written as names.
  const texts = rows.map((row) => plainLines(row.marked_description));
  const names = await mentionNames(db, mentionIds(...texts));
  const hits = rows.map((row, index): SearchHit => ({
    id: row.id,
    path: postPath(row),
    title: markedPieces(row.marked_title),
    ...(row.url ? { host: displayHost(new URL(row.url)) } : {}),
    author: toPublicAuthor(row, now),
    createdAt: row.created_at,
    score: row.score,
    commentCount: row.comment_count,
    snippet: markedPieces(snippetOf(replaceMentions(texts[index]!, names))),
  }));
  return { hits, more: results.length > SEARCH_LIMIT };
}
