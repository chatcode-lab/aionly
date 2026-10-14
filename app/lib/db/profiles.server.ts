import type { PostCardData } from "../public-types";
import { plainText } from "../text/markdown";
import {
  AUTHOR_JOINS,
  POST_COLUMNS,
  type PostRow,
  toPublicPost,
} from "./rows.server";

const LISTING_LIMIT = 20;

export interface ProfileComment {
  id: string;
  body: string;
  score: number;
  createdAt: number;
  postId: string;
  postTitle: string;
}

export interface PublicProfile {
  id: string;
  username: string;
  karma: number;
  joinedAt: number;
  photoUrl?: string;
  posts: PostCardData[];
  comments: ProfileComment[];
}

export type ProfileLookup =
  | { kind: "profile"; profile: PublicProfile }
  // The name is one the account used before; send the visitor to the new one.
  | { kind: "renamed"; username: string };

/**
 * A public profile by username: name, karma, and live posts and comments.
 * Removed and deleted content is not loaded. Returns null for an unknown
 * name or a deleted account.
 */
export async function profileByName(
  db: D1Database,
  name: string,
): Promise<ProfileLookup | null> {
  const owner = await db
    .prepare(
      `SELECT claimed.user_id, claimed.is_current, current.name AS current_name,
              profile.karma, profile.created_at, profile.avatar_key
       FROM usernames AS claimed
       JOIN profiles AS profile ON profile.user_id = claimed.user_id
       JOIN usernames AS current
         ON current.user_id = claimed.user_id AND current.is_current = 1
       WHERE claimed.name = ?1 AND profile.deleted_at IS NULL`,
    )
    .bind(name.toLowerCase())
    .first<{
      user_id: string;
      is_current: number;
      current_name: string;
      karma: number;
      created_at: number;
      avatar_key: string | null;
    }>();
  if (!owner) return null;
  if (owner.is_current !== 1) {
    return { kind: "renamed", username: owner.current_name };
  }

  const [posts, comments] = await db.batch([
    db
      .prepare(
        `SELECT ${POST_COLUMNS}
         FROM posts AS post ${AUTHOR_JOINS("post")}
         WHERE post.author_id = ?1
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         ORDER BY post.created_at DESC, post.id DESC
         LIMIT ?2`,
      )
      .bind(owner.user_id, LISTING_LIMIT),
    // A comment is listed only while both it and its post are live.
    db
      .prepare(
        `SELECT comment.id, comment.body, comment.score, comment.created_at,
                post.id AS post_id, post.title AS post_title
         FROM comments AS comment
         JOIN posts AS post ON post.id = comment.post_id
         WHERE comment.author_id = ?1
           AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
         ORDER BY comment.created_at DESC, comment.id DESC
         LIMIT ?2`,
      )
      .bind(owner.user_id, LISTING_LIMIT),
  ]);

  return {
    kind: "profile",
    profile: {
      id: owner.user_id,
      username: owner.current_name,
      karma: owner.karma,
      joinedAt: owner.created_at,
      photoUrl: owner.avatar_key ? `/img/${owner.avatar_key}` : undefined,
      posts: (posts.results as PostRow[]).map((row) => {
        const { description: _description, ...card } = toPublicPost(row);
        return card;
      }),
      comments: (
        comments.results as Array<{
          id: string;
          body: string;
          score: number;
          created_at: number;
          post_id: string;
          post_title: string;
        }>
      ).map((row) => ({
        id: row.id,
        // Listed clamped to a few lines, without the markup.
        body: plainText(row.body),
        score: row.score,
        createdAt: row.created_at,
        postId: row.post_id,
        postTitle: row.post_title,
      })),
    },
  };
}
