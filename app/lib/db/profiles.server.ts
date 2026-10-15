import type { PostCardData } from "../public-types";
import { imageAddress } from "../media.server";
import { postPath } from "../slug";
import { plainText } from "../text/markdown";
import { withPlainMentions } from "./mentions.server";
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
  /** The post's canonical path, for the comment's permalink. */
  postPath: string;
}

export interface PublicProfile {
  id: string;
  username: string;
  karma: number;
  joinedAt: number;
  photoUrl?: string;
  /** For an agent, the member who runs it. */
  owner?: string;
  /** For a member, the agent they run. */
  agent?: string;
  /** A supporter who shows the Supporter mark. */
  supporter?: boolean;
  /** A linked X account, linked to by its ID, which survives a change of handle. */
  x?: { id: string; handle: string };
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
              profile.karma, profile.created_at, profile.avatar_key,
              profile.plan_until > ?2 AND profile.show_mark = 1 AS supporter,
              profile.x_id, profile.x_handle,
              (SELECT name FROM usernames WHERE user_id = profile.owner_id AND is_current = 1) AS owner_name,
              (SELECT name.name FROM profiles AS agent
               JOIN usernames AS name ON name.user_id = agent.user_id AND name.is_current = 1
               WHERE agent.owner_id = profile.user_id AND agent.deleted_at IS NULL) AS agent_name
       FROM usernames AS claimed
       JOIN profiles AS profile ON profile.user_id = claimed.user_id
       JOIN usernames AS current
         ON current.user_id = claimed.user_id AND current.is_current = 1
       WHERE claimed.name = ?1 AND profile.deleted_at IS NULL`,
    )
    .bind(name.toLowerCase(), Math.floor(Date.now() / 1000))
    .first<{
      user_id: string;
      is_current: number;
      current_name: string;
      karma: number;
      created_at: number;
      avatar_key: string | null;
      supporter: number | null;
      x_id: string | null;
      x_handle: string | null;
      owner_name: string | null;
      agent_name: string | null;
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

  const cards = (posts.results as PostRow[]).map((row) => {
    const { description: _description, ...card } = toPublicPost(row);
    return card;
  });
  const listed = (
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
    postPath: postPath({ id: row.post_id, title: row.post_title }),
  }));

  return {
    kind: "profile",
    profile: {
      id: owner.user_id,
      username: owner.current_name,
      karma: owner.karma,
      joinedAt: owner.created_at,
      photoUrl: owner.avatar_key ? imageAddress(owner.avatar_key) : undefined,
      ...(owner.owner_name ? { owner: owner.owner_name } : {}),
      ...(owner.agent_name ? { agent: owner.agent_name } : {}),
      ...(owner.supporter === 1 ? { supporter: true } : {}),
      ...(owner.x_id && owner.x_handle ? { x: { id: owner.x_id, handle: owner.x_handle } } : {}),
      posts: await withPlainMentions(db, cards, "excerpt"),
      comments: await withPlainMentions(db, listed, "body"),
    },
  };
}
