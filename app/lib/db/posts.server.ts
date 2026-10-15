import { THREAD_MAX } from "../comments/rules";
import type { CommentData, PostDetail } from "../public-types";
import type { PostReplies } from "../replies";
import {
  AUTHOR_JOINS,
  COMMENT_COLUMNS,
  type CommentRow,
  POST_COLUMNS,
  type PostRow,
  toPublicComment,
  toPublicPost,
} from "./rows.server";

/** The most comments one post page loads. */
export const THREAD_LIMIT = THREAD_MAX;

export type PostPage =
  | { state: "live"; post: PostDetail; comments: CommentData[] }
  // A tombstone. The post's title, URL, description, and media are not
  // loaded at all, so they cannot leak into the response.
  | { state: "removed" | "deleted"; comments: CommentData[] };

/**
 * Builds the reply tree. Siblings are ordered by score, then oldest first.
 * A reply whose parent is missing from the loaded set is shown at the top
 * level rather than dropped.
 */
function buildThread(rows: CommentRow[]): CommentData[] {
  const nodes = new Map(rows.map((row) => [row.id, toPublicComment(row)]));
  const roots: CommentData[] = [];

  for (const row of rows) {
    const node = nodes.get(row.id)!;
    const parent = row.parent_id ? nodes.get(row.parent_id) : undefined;
    (parent ? parent.replies : roots).push(node);
  }

  const order = (comments: CommentData[]) => {
    comments.sort(
      (a, b) => b.score - a.score || a.createdAt - b.createdAt || a.id.localeCompare(b.id),
    );
    for (const comment of comments) order(comment.replies);
  };
  order(roots);
  return roots;
}

async function thread(db: D1Database, postId: string): Promise<CommentData[]> {
  const { results } = await db
    .prepare(
      `SELECT ${COMMENT_COLUMNS}
       FROM comments AS comment ${AUTHOR_JOINS("comment")}
       WHERE comment.post_id = ?1
       ORDER BY comment.created_at, comment.id
       LIMIT ?2`,
    )
    .bind(postId, THREAD_LIMIT)
    .all<CommentRow>();
  return buildThread(results);
}

/** Everything a post's own page shows, or null when there is no such post. */
export async function postPage(
  db: D1Database,
  id: string,
): Promise<PostPage | null> {
  const status = await db
    .prepare(`SELECT deleted_at, removed_batch_id FROM posts WHERE id = ?1`)
    .bind(id)
    .first<{ deleted_at: number | null; removed_batch_id: string | null }>();
  if (!status) return null;

  const comments = await thread(db, id);
  // Moderator removal takes precedence when a post carries both flags.
  if (status.removed_batch_id !== null) return { state: "removed", comments };
  if (status.deleted_at !== null) return { state: "deleted", comments };

  const row = await db
    .prepare(
      `SELECT ${POST_COLUMNS}, post.reply_policy, post.comments_closed_at
       FROM posts AS post ${AUTHOR_JOINS("post")}
       WHERE post.id = ?1 AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL`,
    )
    .bind(id)
    .first<PostRow & { reply_policy: Exclude<PostReplies, "all"> | null; comments_closed_at: number | null }>();
  if (!row) {
    // Removed or deleted since the first read: its tombstone, never its content.
    const now = await db
      .prepare(`SELECT removed_batch_id IS NOT NULL AS removed FROM posts WHERE id = ?1`)
      .bind(id)
      .first<{ removed: number }>();
    if (!now) return null;
    return { state: now.removed ? "removed" : "deleted", comments };
  }
  const post = toPublicPost(row);
  // Who may comment holds while the author has the plan, as outside links do.
  if (row.reply_policy && post.author.outsideLinks) post.replies = row.reply_policy;
  // A closed discussion stays closed, plan or not, until its author opens it.
  if (row.comments_closed_at !== null) post.commentsClosed = true;
  return { state: "live", post, comments };
}
