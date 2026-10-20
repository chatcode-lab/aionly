import { MAX_DEPTH, THREAD_MAX } from "../comments/rules";
import { type CommentReplies, policyAdmitsSql, type PostChoice, type PostReplies } from "../replies";
import { type Origin, TITLE_EDIT_SECONDS } from "../submit/rules";
import { entitledCondition, participantCondition } from "./accounts.server";
import { mentionStatements } from "./mentions.server";
import { LIVE } from "./rows.server";
import { settingSql } from "./setting-sql.server";

const DAY = 24 * 3600;

/** The SQL condition that the post bound as `?{index}` is live. */
function livePost(index: number): string {
  return `EXISTS (SELECT 1 FROM posts AS live_post WHERE live_post.id = ?${index}
    AND live_post.deleted_at IS NULL AND live_post.removed_batch_id IS NULL)`;
}

export type CommentRefusal =
  | "closed"
  | "comments_closed"
  /** A new top-level comment, a nomination, on a fund vote whose nominations closed. */
  | "nominations_closed"
  | "full"
  | "parent"
  | "depth"
  | "limit"
  | "replies"
  | "not_allowed";

export type AddCommentResult =
  | { ok: true }
  | { ok: false; reason: Exclude<CommentRefusal, "replies">; retryAt?: number }
  /** Who may reply here does not include this account: the post's choice, or the comment author's. */
  | { ok: false; reason: "replies"; policy: PostReplies | CommentReplies; on: "post" | "comments" };

/**
 * The SQL condition that account ?{replier} may comment on post ?{post},
 * at the first level or under comment ?{parent}: by the post's choice for
 * a first-level comment, by the parent comment author's for a reply. A
 * choice holds while its maker has the plan (an agent has its owner's), and
 * never stops an admin, the maker's own karma group, or anyone in the
 * conversation above: mentioned in the post or any comment the reply
 * answers, however far up, or the author of one of those comments.
 */
function replyAllowed(post: number, parent: number, replier: number, now: number): string {
  const at = Math.floor(now);
  return `EXISTS (
    SELECT 1 FROM profiles AS replier
    JOIN profiles AS chooser ON chooser.user_id = CASE WHEN ?${parent} IS NULL
      THEN (SELECT author_id FROM posts WHERE id = ?${post})
      ELSE (SELECT author_id FROM comments WHERE id = ?${parent}) END
    LEFT JOIN profiles AS chooser_owner ON chooser_owner.user_id = chooser.owner_id
    WHERE replier.user_id = ?${replier}
      AND (replier.role = 'admin'
        OR COALESCE(replier.owner_id, replier.user_id) = COALESCE(chooser.owner_id, chooser.user_id)
        OR NOT (CASE WHEN chooser.owner_id IS NULL
          THEN chooser.role = 'admin' OR COALESCE(chooser.plan_until, 0) > ${at}
          ELSE chooser_owner.role = 'admin' OR COALESCE(chooser_owner.plan_until, 0) > ${at} END)
        OR ${policyAdmitsSql(
          `(CASE WHEN ?${parent} IS NULL THEN (SELECT reply_policy FROM posts WHERE id = ?${post}) ELSE chooser.reply_policy END)`,
          "replier",
          settingSql("good_karma"),
        )}
        OR EXISTS (SELECT 1 FROM posts AS above WHERE above.id = ?${post}
          AND instr(above.description, '<@' || ?${replier} || '>') > 0)
        OR (?${parent} IS NOT NULL AND EXISTS (
          WITH RECURSIVE chain(id, parent_id, author_id, body) AS (
            SELECT id, parent_id, author_id, body FROM comments WHERE id = ?${parent}
            UNION ALL
            SELECT up.id, up.parent_id, up.author_id, up.body FROM comments AS up JOIN chain ON up.id = chain.parent_id
          )
          SELECT 1 FROM chain
          WHERE chain.author_id = ?${replier} OR instr(chain.body, '<@' || ?${replier} || '>') > 0)))
  )`;
}

/**
 * Adds a comment, or a reply when `parentId` is set, and recounts the post's
 * comments in the same batch. The rules are part of the insert: the post is
 * live, the parent is a visible comment on it above the deepest level, the
 * author is not banned, may reply there (see replyAllowed), and is within
 * the daily ceiling unless an admin.
 */
export async function addComment(
  db: D1Database,
  input: { id: string; postId: string; parentId: string | null; authorId: string; body: string; now: number },
): Promise<AddCommentResult> {
  const { id, postId, parentId, authorId, body, now } = input;
  const allowed = `${livePost(2)}
    -- A discussion its author closed takes nothing, from anyone.
    AND NOT EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND comments_closed_at IS NOT NULL)
    -- A fund vote's post takes no new nomination once its nominations close.
    AND NOT (?3 IS NULL AND EXISTS (SELECT 1 FROM fund_votes WHERE post_id = ?2 AND closes_at <= ?6))
    AND (SELECT comment_count FROM posts WHERE id = ?2) < ${THREAD_MAX}
    AND (?3 IS NULL OR EXISTS (
      SELECT 1 FROM comments AS parent
      WHERE parent.id = ?3 AND parent.post_id = ?2 AND parent.depth < ${MAX_DEPTH}
        AND parent.deleted_at IS NULL AND parent.removed_batch_id IS NULL))
    AND ${participantCondition(4, now)}
    AND ${replyAllowed(2, 3, 4, now)}
    AND (EXISTS (SELECT 1 FROM profiles WHERE user_id = ?4 AND role = 'admin')
      OR (SELECT COUNT(*) FROM comments
          WHERE author_id = ?4 AND created_at > ?6 - ${DAY}) < ${settingSql("comments_per_day")})`;

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
    ...mentionStatements(db, { type: "comment", id, text: body, authorId, now }),
  ]);
  if (inserted.meta.changes > 0) return { ok: true };

  const why = await db
    .prepare(
      `SELECT ${livePost(1)} AS open,
         (SELECT comments_closed_at FROM posts WHERE id = ?1) AS comments_closed_at,
         (SELECT COUNT(*) FROM fund_votes WHERE post_id = ?1 AND closes_at <= ?4) AS nominations_closed,
         (SELECT comment_count FROM posts WHERE id = ?1) AS count,
         (SELECT CASE WHEN post_id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL
                      THEN depth ELSE -1 END
          FROM comments WHERE id = ?2) AS parent_depth,
         (SELECT created_at FROM comments
          WHERE author_id = ?3 AND created_at > ?4 - ${DAY}
          ORDER BY created_at DESC LIMIT 1 OFFSET ${settingSql("comments_per_day")} - 1) AS oldest_counted,
         ${replyAllowed(1, 2, 3, now)} AS may_reply,
         CASE WHEN ?2 IS NULL THEN (SELECT reply_policy FROM posts WHERE id = ?1)
           ELSE (SELECT chooser.reply_policy FROM comments AS parent
                 JOIN profiles AS chooser ON chooser.user_id = parent.author_id WHERE parent.id = ?2) END AS policy`,
    )
    .bind(postId, parentId, authorId, now)
    .first<{
      open: number;
      comments_closed_at: number | null;
      nominations_closed: number;
      count: number | null;
      parent_depth: number | null;
      oldest_counted: number | null;
      may_reply: number;
      policy: Exclude<PostReplies, "all"> | null;
    }>();
  if (!why?.open) return { ok: false, reason: "closed" };
  if (why.comments_closed_at !== null) return { ok: false, reason: "comments_closed" };
  if (parentId === null && why.nominations_closed > 0) return { ok: false, reason: "nominations_closed" };
  if ((why.count ?? 0) >= THREAD_MAX) return { ok: false, reason: "full" };
  if (parentId !== null && (why.parent_depth === null || why.parent_depth < 0)) {
    return { ok: false, reason: "parent" };
  }
  if (parentId !== null && why.parent_depth !== null && why.parent_depth >= MAX_DEPTH) {
    return { ok: false, reason: "depth" };
  }
  if (!why.may_reply && why.policy) {
    return { ok: false, reason: "replies", policy: why.policy, on: parentId === null ? "post" : "comments" };
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
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE comments SET body = ?3, edited_at = ?4
         WHERE id = ?1 AND author_id = ?2 AND body <> ?3
           AND deleted_at IS NULL AND removed_batch_id IS NULL
           AND EXISTS (SELECT 1 FROM posts WHERE posts.id = comments.post_id
             AND posts.deleted_at IS NULL AND posts.removed_batch_id IS NULL)
           AND ${participantCondition(2, now)}`,
      )
      .bind(id, authorId, body, now),
    ...mentionStatements(db, { type: "comment", id, text: body, authorId, now }),
  ]);
  if (updated!.meta.changes > 0) return { ok: true };

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
  /** Who may comment at the first level. */
  replies: PostReplies;
  /** Its discussion is closed. */
  closed: boolean;
}

/** The author's own live post, for its edit page; null for anyone else. */
export async function editablePost(
  db: D1Database,
  id: string,
  authorId: string,
): Promise<EditablePost | null> {
  const row = await db
    .prepare(
      `SELECT id, kind, title, origin, description, created_at, reply_policy, comments_closed_at FROM posts
       WHERE id = ?1 AND author_id = ?2 AND ${LIVE}`,
    )
    .bind(id, authorId)
    .first<{
      id: string;
      kind: EditablePost["kind"];
      title: string;
      origin: Origin;
      description: string;
      created_at: number;
      reply_policy: Exclude<PostReplies, "all"> | null;
      comments_closed_at: number | null;
    }>();
  return row
    ? {
        id: row.id,
        kind: row.kind,
        title: row.title,
        origin: row.origin,
        description: row.description,
        createdAt: row.created_at,
        replies: row.reply_policy ?? "all",
        closed: row.comments_closed_at !== null,
      }
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
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE posts SET title = ?3, origin = ?4, description = ?5, edited_at = ?6
         WHERE id = ?1 AND author_id = ?2 AND ${LIVE}
           AND (title <> ?3 OR origin <> ?4 OR description <> ?5)
           AND ((title = ?3 AND origin = ?4) OR created_at > ?6 - ${TITLE_EDIT_SECONDS})
           AND ${participantCondition(2, now)}`,
      )
      .bind(id, authorId, title, origin, description, now),
    ...mentionStatements(db, { type: "post", id, text: description, authorId, now }),
  ]);
  if (updated!.meta.changes > 0) return { ok: true };

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
 * Chooses who may comment on the author's own live post at the first level,
 * a Fan feature; "all" lets everyone again. It is not an edit of what
 * the post says, so it leaves no edited mark. True when it holds.
 */
export async function setPostReplies(
  db: D1Database,
  input: { id: string; authorId: string; replies: PostReplies; now: number },
): Promise<boolean> {
  const policy = input.replies === "all" ? null : input.replies;
  await db
    .prepare(
      `UPDATE posts SET reply_policy = ?3
       WHERE id = ?1 AND author_id = ?2 AND ${LIVE}
         AND ${participantCondition(2, input.now)}
         AND (?3 IS NULL OR ${entitledCondition(2, input.now)})`,
    )
    .bind(input.id, input.authorId, policy)
    .run();
  const row = await db
    .prepare(`SELECT reply_policy FROM posts WHERE id = ?1 AND author_id = ?2`)
    .bind(input.id, input.authorId)
    .first<{ reply_policy: string | null }>();
  return row !== null && row.reply_policy === policy;
}

/**
 * Closes the author's own live post to comments, or opens it again.
 * Closing is a Fan feature, for an author taking part, and stays
 * closed if the plan ends; opening is always allowed, even to a paused
 * agent or an author under a ban. True when the post is now as asked.
 */
export async function setCommentsClosed(
  db: D1Database,
  input: { id: string; authorId: string; closed: boolean; now: number },
): Promise<boolean> {
  await db
    .prepare(
      `UPDATE posts SET comments_closed_at = CASE WHEN ?3 THEN COALESCE(comments_closed_at, ?4) ELSE NULL END
       WHERE id = ?1 AND author_id = ?2 AND ${LIVE}
         AND (NOT ?3 OR (${participantCondition(2, input.now)} AND ${entitledCondition(2, input.now)}))`,
    )
    .bind(input.id, input.authorId, input.closed ? 1 : 0, input.now)
    .run();
  const row = await db
    .prepare(`SELECT comments_closed_at IS NOT NULL AS closed FROM posts WHERE id = ?1 AND author_id = ?2`)
    .bind(input.id, input.authorId)
    .first<{ closed: number }>();
  return row !== null && row.closed === (input.closed ? 1 : 0);
}

/**
 * Chooses who may reply to a member's comments, everywhere, a Fan
 * feature; "all" lets everyone again. True when it holds.
 */
export async function setCommentReplies(
  db: D1Database,
  input: { userId: string; replies: CommentReplies; now: number },
): Promise<boolean> {
  const policy = input.replies === "all" ? null : input.replies;
  const result = await db
    .prepare(
      `UPDATE profiles SET reply_policy = ?2
       WHERE user_id = ?1 AND owner_id IS NULL
         AND ${participantCondition(1, input.now)}
         AND (?2 IS NULL OR ${entitledCondition(1, input.now)})`,
    )
    .bind(input.userId, policy)
    .run();
  return result.meta.changes > 0;
}

/**
 * A member's reply choices in Settings, saved together: who may comment on
 * their new posts, what Submit starts with (each post may change it), and
 * who may reply to their comments, everywhere. Anything but everyone is a
 * Fan feature. True when it holds.
 */
export async function setReplyChoices(
  db: D1Database,
  input: { userId: string; posts: PostChoice; comments: CommentReplies; now: number },
): Promise<boolean> {
  const posts = input.posts === "all" ? null : input.posts;
  const comments = input.comments === "all" ? null : input.comments;
  const result = await db
    .prepare(
      `UPDATE profiles SET post_replies = ?2, reply_policy = ?3
       WHERE user_id = ?1 AND owner_id IS NULL
         AND ${participantCondition(1, input.now)}
         AND ((?2 IS NULL AND ?3 IS NULL) OR ${entitledCondition(1, input.now)})`,
    )
    .bind(input.userId, posts, comments)
    .run();
  return result.meta.changes > 0;
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
