import { COMMENTS_PER_DAY, MAX_DEPTH } from "../comments/rules";
import { type Origin, TITLE_EDIT_SECONDS } from "../submit/rules";
import { participantCondition } from "./accounts.server";
import { LIVE } from "./rows.server";

const DAY = 24 * 3600;

/** The SQL condition that the post bound as `?{index}` is live. */
function livePost(index: number): string {
  return `EXISTS (SELECT 1 FROM posts AS live_post WHERE live_post.id = ?${index}
    AND live_post.deleted_at IS NULL AND live_post.removed_batch_id IS NULL)`;
}

export type CommentRefusal = "closed" | "parent" | "depth" | "limit" | "not_allowed";

export type AddCommentResult =
  | { ok: true }
  | { ok: false; reason: CommentRefusal; retryAt?: number };

/**
 * Adds a comment, or a reply when `parentId` is set, and recounts the post's
 * comments in the same batch. The rules are part of the insert: the post is
 * live, the parent is a visible comment on it above the deepest level, the
 * author is not banned, and is within the daily ceiling unless an admin.
 */
export async function addComment(
  db: D1Database,
  input: { id: string; postId: string; parentId: string | null; authorId: string; body: string; now: number },
): Promise<AddCommentResult> {
  const { id, postId, parentId, authorId, body, now } = input;
  const allowed = `${livePost(2)}
    AND (?3 IS NULL OR EXISTS (
      SELECT 1 FROM comments AS parent
      WHERE parent.id = ?3 AND parent.post_id = ?2 AND parent.depth < ${MAX_DEPTH}
        AND parent.deleted_at IS NULL AND parent.removed_batch_id IS NULL))
    AND ${participantCondition(4, now)}
    AND (EXISTS (SELECT 1 FROM profiles WHERE user_id = ?4 AND role = 'admin')
      OR (SELECT COUNT(*) FROM comments
          WHERE author_id = ?4 AND created_at > ?6 - ${DAY}) < ${COMMENTS_PER_DAY})`;

  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO comments (id, post_id, parent_id, author_id, body, depth, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5,
           COALESCE((SELECT depth + 1 FROM comments WHERE id = ?3), 0), ?6
         WHERE ${allowed}`,
      )
      .bind(id, postId, parentId, authorId, body, now),
    db
      .prepare(`UPDATE posts SET comment_count = (SELECT COUNT(*) FROM comments WHERE post_id = ?1) WHERE id = ?1`)
      .bind(postId),
  ]);
  if (inserted.meta.changes > 0) return { ok: true };

  const why = await db
    .prepare(
      `SELECT ${livePost(1)} AS open,
         (SELECT CASE WHEN post_id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL
                      THEN depth ELSE -1 END
          FROM comments WHERE id = ?2) AS parent_depth,
         (SELECT created_at FROM comments
          WHERE author_id = ?3 AND created_at > ?4 - ${DAY}
          ORDER BY created_at DESC LIMIT 1 OFFSET ${COMMENTS_PER_DAY - 1}) AS oldest_counted`,
    )
    .bind(postId, parentId, authorId, now)
    .first<{ open: number; parent_depth: number | null; oldest_counted: number | null }>();
  if (!why?.open) return { ok: false, reason: "closed" };
  if (parentId !== null && (why.parent_depth === null || why.parent_depth < 0)) {
    return { ok: false, reason: "parent" };
  }
  if (parentId !== null && why.parent_depth !== null && why.parent_depth >= MAX_DEPTH) {
    return { ok: false, reason: "depth" };
  }
  if (why.oldest_counted !== null) {
    return { ok: false, reason: "limit", retryAt: why.oldest_counted + DAY };
  }
  return { ok: false, reason: "not_allowed" };
}

export type EditRefusal = "not_found" | "closed" | "window" | "not_allowed";
export type EditResult = { ok: true } | { ok: false; reason: EditRefusal };

/**
 * Changes a comment's text. Only its author may, while it and its post are
 * live and the author is not banned. The same text again changes nothing.
 */
export async function editComment(
  db: D1Database,
  input: { id: string; authorId: string; body: string; now: number },
): Promise<EditResult> {
  const { id, authorId, body, now } = input;
  const updated = await db
    .prepare(
      `UPDATE comments SET body = ?3, edited_at = ?4
       WHERE id = ?1 AND author_id = ?2 AND body <> ?3
         AND deleted_at IS NULL AND removed_batch_id IS NULL
         AND EXISTS (SELECT 1 FROM posts WHERE posts.id = comments.post_id
           AND posts.deleted_at IS NULL AND posts.removed_batch_id IS NULL)
         AND ${participantCondition(2, now)}`,
    )
    .bind(id, authorId, body, now)
    .run();
  if (updated.meta.changes > 0) return { ok: true };

  const row = await db
    .prepare(
      `SELECT comment.body, comment.author_id,
         comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL AS open
       FROM comments AS comment JOIN posts AS post ON post.id = comment.post_id
       WHERE comment.id = ?1`,
    )
    .bind(id)
    .first<{ body: string; author_id: string; open: number }>();
  if (!row || row.author_id !== authorId) return { ok: false, reason: "not_found" };
  if (!row.open) return { ok: false, reason: "closed" };
  if (row.body === body) return { ok: true };
  return { ok: false, reason: "not_allowed" };
}

export type DeleteResult = { ok: true } | { ok: false; reason: "not_found" | "closed" | "not_allowed" };

/**
 * Deletes the author's own comment for good. It keeps its place in the
 * thread as [deleted by author], with its replies; its text is wiped.
 */
export async function deleteComment(
  db: D1Database,
  input: { id: string; authorId: string; now: number },
): Promise<DeleteResult> {
  const { id, authorId, now } = input;
  const updated = await db
    .prepare(
      `UPDATE comments SET deleted_at = ?3, body = ''
       WHERE id = ?1 AND author_id = ?2
         AND deleted_at IS NULL AND removed_batch_id IS NULL
         AND ${participantCondition(2, now)}`,
    )
    .bind(id, authorId, now)
    .run();
  if (updated.meta.changes > 0) return { ok: true };
  return refusedDelete(db, "comments", id, authorId);
}

async function refusedDelete(
  db: D1Database,
  table: "posts" | "comments",
  id: string,
  authorId: string,
): Promise<DeleteResult> {
  const row = await db
    .prepare(
      `SELECT author_id, deleted_at IS NULL AND removed_batch_id IS NULL AS open
       FROM ${table} WHERE id = ?1`,
    )
    .bind(id)
    .first<{ author_id: string; open: number }>();
  if (!row || row.author_id !== authorId) return { ok: false, reason: "not_found" };
  if (!row.open) return { ok: false, reason: "closed" };
  return { ok: false, reason: "not_allowed" };
}

/** A post as its author edits it. */
export interface EditablePost {
  id: string;
  kind: "link" | "text" | "upload";
  title: string;
  origin: Origin;
  description: string;
  createdAt: number;
}

/** The author's own live post, for its edit page; null for anyone else. */
export async function editablePost(
  db: D1Database,
  id: string,
  authorId: string,
): Promise<EditablePost | null> {
  const row = await db
    .prepare(
      `SELECT id, kind, title, origin, description, created_at FROM posts
       WHERE id = ?1 AND author_id = ?2 AND ${LIVE}`,
    )
    .bind(id, authorId)
    .first<{ id: string; kind: EditablePost["kind"]; title: string; origin: Origin; description: string; created_at: number }>();
  return row
    ? { id: row.id, kind: row.kind, title: row.title, origin: row.origin, description: row.description, createdAt: row.created_at }
    : null;
}

/**
 * Changes a post's description, and its title and "made" or "found" within
 * an hour of posting. Its link never changes. Nothing changed, nothing is
 * written, so the post is not marked edited.
 */
export async function editPost(
  db: D1Database,
  input: { id: string; authorId: string; title: string; origin: Origin; description: string; now: number },
): Promise<EditResult> {
  const { id, authorId, title, origin, description, now } = input;
  const updated = await db
    .prepare(
      `UPDATE posts SET title = ?3, origin = ?4, description = ?5, edited_at = ?6
       WHERE id = ?1 AND author_id = ?2 AND ${LIVE}
         AND (title <> ?3 OR origin <> ?4 OR description <> ?5)
         AND ((title = ?3 AND origin = ?4) OR created_at > ?6 - ${TITLE_EDIT_SECONDS})
         AND ${participantCondition(2, now)}`,
    )
    .bind(id, authorId, title, origin, description, now)
    .run();
  if (updated.meta.changes > 0) return { ok: true };

  const row = await db
    .prepare(
      `SELECT author_id, title, origin, description, created_at,
         deleted_at IS NULL AND removed_batch_id IS NULL AS open
       FROM posts WHERE id = ?1`,
    )
    .bind(id)
    .first<{ author_id: string; title: string; origin: Origin; description: string; created_at: number; open: number }>();
  if (!row || row.author_id !== authorId) return { ok: false, reason: "not_found" };
  if (!row.open) return { ok: false, reason: "closed" };
  if (row.title === title && row.origin === origin && row.description === description) return { ok: true };
  if ((row.title !== title || row.origin !== origin) && row.created_at <= now - TITLE_EDIT_SECONDS) {
    return { ok: false, reason: "window" };
  }
  return { ok: false, reason: "not_allowed" };
}

/**
 * Deletes the author's own post for good. It leaves the feed and profile,
 * its permalink becomes [deleted by author], its comments stay read-only,
 * and its link can be posted again. Its title and description are wiped;
 * its picture is swept away later.
 */
export async function deletePost(
  db: D1Database,
  input: { id: string; authorId: string; now: number },
): Promise<DeleteResult> {
  const { id, authorId, now } = input;
  const updated = await db
    .prepare(
      `UPDATE posts SET deleted_at = ?3, title = '', description = ''
       WHERE id = ?1 AND author_id = ?2 AND ${LIVE}
         AND ${participantCondition(2, now)}`,
    )
    .bind(id, authorId, now)
    .run();
  if (updated.meta.changes > 0) return { ok: true };
  return refusedDelete(db, "posts", id, authorId);
}
