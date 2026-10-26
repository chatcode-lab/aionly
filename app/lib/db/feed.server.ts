import { PAGE_SIZE, type Range, SNAPSHOT_LIMIT } from "../feed";
import type { PostCardData } from "../public-types";
import { withPlainMentions } from "./mentions.server";
import {
  AUTHOR_JOINS,
  LIVE,
  POST_COLUMNS,
  type PostRow,
  toPublicCard,
} from "./rows.server";

/** A range needs this many posts to be the default on arrival. */
const COLD_START_MINIMUM = 10;

const RANGE_SECONDS: Record<Range, number | null> = {
  day: 24 * 3600,
  week: 7 * 24 * 3600,
  month: 30 * 24 * 3600,
  all: null,
};

/** The earliest publication time a range admits, or 0 for all time. */
function since(range: Range, now: number): number {
  const seconds = RANGE_SECONDS[range];
  return seconds === null ? 0 : now - seconds;
}

/**
 * The range to show when the URL names none: the narrowest of week, month,
 * and all time that has enough posts to fill a first screen.
 */
export async function defaultRange(db: D1Database, now: number): Promise<Range> {
  // Each count stops at the minimum, reading a handful of rows by date
  // rather than every post.
  const enough = (index: number) => `(SELECT COUNT(*) FROM (
    SELECT 1 FROM posts WHERE created_at >= ?${index} AND ${LIVE}
    LIMIT ${COLD_START_MINIMUM}))`;
  const counts = await db
    .prepare(`SELECT ${enough(1)} AS week, ${enough(2)} AS month`)
    .bind(since("week", now), since("month", now))
    .first<{ week: number; month: number }>();

  if ((counts?.week ?? 0) >= COLD_START_MINIMUM) return "week";
  if ((counts?.month ?? 0) >= COLD_START_MINIMUM) return "month";
  return "all";
}

/**
 * The Top ranking at this moment, as ordered post IDs. Scores keep changing
 * while someone reads, so the page is cut from this fixed list rather than
 * from a moving query: later votes can neither skip nor repeat a post.
 */
export async function topSnapshot(
  db: D1Database,
  range: Range,
  now: number,
): Promise<string[]> {
  // A day, week, or month reads only its own posts, by date, and sorts
  // them; left to choose, SQLite walks the score index across all time.
  // All time walks that index and stops at the limit.
  const { results } = await db
    .prepare(
      `SELECT id FROM posts ${range === "all" ? "" : "INDEXED BY posts_new"}
       WHERE ${LIVE} AND created_at >= ?1
       ORDER BY score DESC, created_at DESC, id DESC
       LIMIT ?2`,
    )
    .bind(since(range, now), SNAPSHOT_LIMIT)
    .all<{ id: string }>();
  return results.map((row) => row.id);
}

const POST_ID = /^[A-Za-z0-9_-]{1,32}$/;

/**
 * Loads posts by ID, in the order given. Posts removed or deleted since the
 * snapshot was taken are left out. At most one page is loaded per call.
 */
export async function postsByIds(
  db: D1Database,
  ids: readonly string[],
): Promise<PostCardData[]> {
  const wanted = ids.filter((id) => POST_ID.test(id)).slice(0, PAGE_SIZE);
  if (wanted.length === 0) return [];

  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS}
       FROM posts AS post ${AUTHOR_JOINS("post")}
       WHERE post.id IN (${wanted.map((_, index) => `?${index + 1}`).join(", ")})
         AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
    )
    .bind(...wanted)
    .all<PostRow>();

  const byId = new Map(results.map((row) => [row.id, row]));
  const cards = wanted.flatMap((id) => {
    const row = byId.get(id);
    return row ? [toPublicCard(row)] : [];
  });
  return withPlainMentions(db, cards, "excerpt");
}

interface NewCursor {
  createdAt: number;
  id: string;
}

function encodeCursor(cursor: NewCursor): string {
  return btoa(`${cursor.createdAt}:${cursor.id}`);
}

function decodeCursor(value: string | null): NewCursor | null {
  if (!value) return null;
  try {
    const [createdAt, id] = atob(value).split(":");
    const time = Number(createdAt);
    if (!Number.isSafeInteger(time) || !id || !POST_ID.test(id)) return null;
    return { createdAt: time, id };
  } catch {
    return null;
  }
}

/**
 * One page of the New feed. Publication time never changes, so a plain
 * cursor on it is stable; no snapshot is needed.
 */
export async function newPage(
  db: D1Database,
  range: Range,
  now: number,
  cursor: string | null,
): Promise<{ posts: PostCardData[]; nextCursor: string | null }> {
  const after = decodeCursor(cursor);
  const { results } = await db
    .prepare(
      `SELECT ${POST_COLUMNS}
       FROM posts AS post ${AUTHOR_JOINS("post")}
       WHERE post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         AND post.created_at >= ?1
         AND (?2 IS NULL OR (post.created_at, post.id) < (?2, ?3))
       ORDER BY post.created_at DESC, post.id DESC
       LIMIT ?4`,
    )
    .bind(
      since(range, now),
      after?.createdAt ?? null,
      after?.id ?? null,
      PAGE_SIZE + 1,
    )
    .all<PostRow>();

  const page = results.slice(0, PAGE_SIZE);
  const last = page[page.length - 1];
  return {
    posts: await withPlainMentions(db, page.map(toPublicCard), "excerpt"),
    nextCursor:
      results.length > PAGE_SIZE && last
        ? encodeCursor({ createdAt: last.created_at, id: last.id })
        : null,
  };
}
