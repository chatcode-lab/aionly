import type { PostCardData } from "../public-types";
import { participantCondition } from "./accounts.server";
import { withPlainMentions } from "./mentions.server";
import {
  AUTHOR_JOINS,
  POST_COLUMNS,
  type PostRow,
  toPublicPost,
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
         WHERE post.id IN (SELECT value FROM json_each(?1))`,
      )
      .bind(JSON.stringify(liveIds))
      .all<PostRow>();
    const cards = rows.map((row) => {
      const { description: _description, ...card } = toPublicPost(row);
      return card;
    });
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
