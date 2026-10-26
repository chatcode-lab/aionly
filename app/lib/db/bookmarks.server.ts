import type { PostCardData, PublicAuthor } from "../public-types";
import { postPath } from "../slug";
import { participantCondition } from "./accounts.server";
import { withPlainMentions } from "./mentions.server";
import {
  AUTHOR_COLUMNS,
  AUTHOR_JOINS,
  POST_COLUMNS,
  type PostRow,
  toPublicAuthor,
  toPublicCard,
} from "./rows.server";

/** The most saved posts the Saved page lists. */
export const SAVED_LIMIT = 200;

/**
 * Saves or unsaves a post for one account. Only a live post can be saved;
 * any saved post can be unsaved, including one removed since. Returns false
 * when a save was refused.
 */
export async function setSaved(
  db: D1Database,
  input: { userId: string; postId: string; saved: boolean; now: number },
): Promise<boolean> {
  const { userId, postId, saved, now } = input;
  if (!saved) {
    await db
      .prepare(`DELETE FROM bookmarks WHERE user_id = ?1 AND post_id = ?2`)
      .bind(userId, postId)
      .run();
    return true;
  }
  const result = await db
    .prepare(
      `INSERT INTO bookmarks (user_id, post_id, created_at)
       SELECT ?1, ?2, ?3
       WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?2
                       AND deleted_at IS NULL AND removed_batch_id IS NULL)
         AND ${participantCondition(1, now)}
       ON CONFLICT (user_id, post_id) DO NOTHING`,
    )
    .bind(userId, postId, now)
    .run();
  if (result.meta.changes > 0) return true;
  // Already saved counts as saved.
  const existing = await db
    .prepare(`SELECT 1 FROM bookmarks WHERE user_id = ?1 AND post_id = ?2`)
    .bind(userId, postId)
    .first();
  return existing !== null;
}

/** Which of the given posts the account has saved. */
export async function savedAmong(
  db: D1Database,
  userId: string,
  postIds: readonly string[],
): Promise<string[]> {
  if (postIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT post_id FROM bookmarks
       WHERE user_id = ?1 AND post_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(userId, JSON.stringify([...new Set(postIds)]))
    .all<{ post_id: string }>();
  return results.map((row) => row.post_id);
}

export type SavedEntry =
  | { state: "live"; savedAt: number; post: PostCardData }
  // The post is gone; its title and link are not loaded at all.
  | { state: "removed" | "deleted"; savedAt: number; postId: string };

/** The account's saved posts, newest saved first. Private to that account. */
export async function savedPosts(
  db: D1Database,
  userId: string,
): Promise<SavedEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT bookmark.post_id, bookmark.created_at AS saved_at,
              post.deleted_at, post.removed_batch_id
       FROM bookmarks AS bookmark
       JOIN posts AS post ON post.id = bookmark.post_id
       WHERE bookmark.user_id = ?1
       ORDER BY bookmark.created_at DESC, bookmark.post_id DESC
       LIMIT ?2`,
    )
    .bind(userId, SAVED_LIMIT)
    .all<{
      post_id: string;
      saved_at: number;
      deleted_at: number | null;
      removed_batch_id: string | null;
    }>();

  const liveIds = results
    .filter((row) => row.deleted_at === null && row.removed_batch_id === null)
    .map((row) => row.post_id);
  const live = new Map<string, PostCardData>();
  if (liveIds.length > 0) {
    const { results: rows } = await db
      .prepare(
        `SELECT ${POST_COLUMNS}
         FROM posts AS post ${AUTHOR_JOINS("post")}
         WHERE post.id IN (SELECT value FROM json_each(?1))
           -- Checked again here: a post removed since the first read shows as gone.
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
      )
      .bind(JSON.stringify(liveIds))
      .all<PostRow>();
    const cards = rows.map(toPublicCard);
    for (const card of await withPlainMentions(db, cards, "excerpt")) live.set(card.id, card);
  }

  return results.map((row): SavedEntry => {
    const post = live.get(row.post_id);
    if (post) return { state: "live", savedAt: row.saved_at, post };
    return {
      // Moderator removal takes precedence when a post carries both flags.
      state: row.removed_batch_id !== null ? "removed" : "deleted",
      savedAt: row.saved_at,
      postId: row.post_id,
    };
  });
}

/**
 * Saves or unsaves a comment for one account, as setSaved does a post: only
 * a visible comment on a live post can be saved; any can be unsaved.
 */
export async function setSavedComment(
  db: D1Database,
  input: { userId: string; commentId: string; saved: boolean; now: number },
): Promise<boolean> {
  const { userId, commentId, saved, now } = input;
  if (!saved) {
    await db.prepare(`DELETE FROM comment_bookmarks WHERE user_id = ?1 AND comment_id = ?2`).bind(userId, commentId).run();
    return true;
  }
  const result = await db
    .prepare(
      `INSERT INTO comment_bookmarks (user_id, comment_id, created_at)
       SELECT ?1, ?2, ?3
       WHERE EXISTS (SELECT 1 FROM comments AS comment JOIN posts AS post ON post.id = comment.post_id
                     WHERE comment.id = ?2 AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
                       AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL)
         AND ${participantCondition(1, now)}
       ON CONFLICT (user_id, comment_id) DO NOTHING`,
    )
    .bind(userId, commentId, now)
    .run();
  if (result.meta.changes > 0) return true;
  const existing = await db
    .prepare(`SELECT 1 FROM comment_bookmarks WHERE user_id = ?1 AND comment_id = ?2`)
    .bind(userId, commentId)
    .first();
  return existing !== null;
}

/** Which of the given comments the account has saved. */
export async function savedCommentsAmong(db: D1Database, userId: string, commentIds: readonly string[]): Promise<string[]> {
  if (commentIds.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT comment_id FROM comment_bookmarks
       WHERE user_id = ?1 AND comment_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(userId, JSON.stringify([...new Set(commentIds)]))
    .all<{ comment_id: string }>();
  return results.map((row) => row.comment_id);
}

export type SavedCommentEntry =
  | {
      state: "live";
      savedAt: number;
      comment: { id: string; body: string; author: PublicAuthor; createdAt: number; score: number; postTitle: string; postPath: string };
    }
  // The comment, or its post, is gone; its text is not loaded at all.
  | { state: "removed" | "deleted"; savedAt: number; commentId: string };

/** The account's saved comments, newest saved first. Private to that account. */
export async function savedComments(db: D1Database, userId: string): Promise<SavedCommentEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT bookmark.comment_id, bookmark.created_at AS saved_at,
              CASE WHEN comment.removed_batch_id IS NOT NULL OR post.removed_batch_id IS NOT NULL THEN 'removed'
                   WHEN comment.deleted_at IS NOT NULL OR post.deleted_at IS NOT NULL THEN 'deleted'
                   ELSE 'live' END AS state,
              CASE WHEN comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
                     AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL THEN comment.body END AS body,
              comment.created_at, comment.score, post.id AS post_id, post.title AS post_title, ${AUTHOR_COLUMNS}
       FROM comment_bookmarks AS bookmark
       JOIN comments AS comment ON comment.id = bookmark.comment_id
       JOIN posts AS post ON post.id = comment.post_id
       ${AUTHOR_JOINS("comment")}
       WHERE bookmark.user_id = ?1
       ORDER BY bookmark.created_at DESC, bookmark.comment_id DESC
       LIMIT ?2`,
    )
    .bind(userId, SAVED_LIMIT)
    .all<
      Parameters<typeof toPublicAuthor>[0] & {
        comment_id: string;
        saved_at: number;
        state: "live" | "removed" | "deleted";
        body: string | null;
        created_at: number;
        score: number;
        post_id: string;
        post_title: string;
      }
    >();
  return results.map((row): SavedCommentEntry =>
    row.state === "live" && row.body !== null
      ? {
          state: "live",
          savedAt: row.saved_at,
          comment: {
            id: row.comment_id,
            body: row.body,
            author: toPublicAuthor(row),
            createdAt: row.created_at,
            score: row.score,
            postTitle: row.post_title,
            postPath: postPath({ id: row.post_id, title: row.post_title }),
          },
        }
      : { state: row.state === "live" ? "deleted" : row.state, savedAt: row.saved_at, commentId: row.comment_id },
  );
}
