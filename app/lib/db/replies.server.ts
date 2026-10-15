import type { PublicAuthor } from "../public-types";
import { postPath } from "../slug";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, toPublicAuthor } from "./rows.server";

/** Replies one call returns at most. */
export const REPLIES_LIMIT = 50;

export interface Reply {
  id: string;
  postId: string;
  postTitle: string;
  postPath: string;
  /** The account's comment this answers, or null for a comment on its post. */
  parentId: string | null;
  author: PublicAuthor;
  body: string;
  createdAt: number;
}

/**
 * Comments answering an account since a time, newest first: those on its
 * live posts, and replies to its comments, by anyone but itself. Found
 * through its own posts and comments, by index, so the cost follows what
 * it wrote rather than the size of the board.
 */
export async function repliesTo(db: D1Database, accountId: string, since: number, limit = REPLIES_LIMIT): Promise<Reply[]> {
  const { results } = await db
    .prepare(
      `SELECT reply.id, reply.post_id, reply.parent_id, reply.body, reply.created_at,
              post.title AS post_title, ${AUTHOR_COLUMNS}
       FROM (
         SELECT answer.* FROM comments AS mine
         JOIN comments AS answer ON answer.parent_id = mine.id
         WHERE mine.author_id = ?1 AND mine.deleted_at IS NULL AND mine.removed_batch_id IS NULL
           AND answer.created_at > ?2
         UNION ALL
         SELECT answer.* FROM posts AS mine
         JOIN comments AS answer ON answer.post_id = mine.id AND answer.parent_id IS NULL
         WHERE mine.author_id = ?1 AND mine.deleted_at IS NULL AND mine.removed_batch_id IS NULL
           AND answer.created_at > ?2
       ) AS reply
       JOIN posts AS post ON post.id = reply.post_id
       ${AUTHOR_JOINS("reply")}
       WHERE reply.author_id != ?1 AND reply.deleted_at IS NULL AND reply.removed_batch_id IS NULL
         AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
       ORDER BY reply.created_at DESC
       LIMIT ?3`,
    )
    .bind(accountId, since, limit)
    .all<Parameters<typeof toPublicAuthor>[0] & {
      id: string;
      post_id: string;
      parent_id: string | null;
      body: string;
      created_at: number;
      post_title: string;
    }>();
  return results.map((row) => ({
    id: row.id,
    postId: row.post_id,
    postTitle: row.post_title,
    postPath: postPath({ id: row.post_id, title: row.post_title }),
    parentId: row.parent_id,
    author: toPublicAuthor(row),
    body: row.body,
    createdAt: row.created_at,
  }));
}
