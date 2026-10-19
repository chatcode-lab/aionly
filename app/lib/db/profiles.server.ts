import type { PostCardData } from "../public-types";
import { imageAddress } from "../media.server";
import { postPath } from "../slug";
import { plainText } from "../text/markdown";
import { termsOf } from "./editors.server";
import { withPlainMentions } from "./mentions.server";
import {
  AUTHOR_JOINS,
  POST_COLUMNS,
  type PostRow,
  toPublicPost,
} from "./rows.server";

const LISTING_LIMIT = 20;

/** A place in a profile's posts or comments, newest first: before this time and ID. */
export function profileCursor(item: { createdAt: number; id: string }): string {
  return `${item.createdAt}:${item.id}`;
}

function parseCursor(value: string | null | undefined): { at: number; id: string } | null {
  const match = /^(\d{1,12}):([A-Za-z0-9_-]{1,32})$/.exec(value ?? "");
  return match ? { at: Number(match[1]), id: match[2]! } : null;
}

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
  /** A fan who shows the fan mark. */
  fan?: boolean;
  /** A linked X account, linked to by its ID, which survives a change of handle. */
  x?: { id: string; handle: string };
  /** Who invited this member, when they came by invitation. */
  invitedBy?: string;
  /** What their fresh starts gave to the fund, in cents, when they show it. */
  giftCents?: number;
  /** Their terms as guest editor, latest first. */
  editorTerms?: Array<{ startsAt: number; endsAt: number }>;
  /** Members they invited, newest first, and how many in all. */
  invited: { names: string[]; total: number };
  /** The part of their karma that comes from those they invited. */
  inviteKarma: number;
  posts: PostCardData[];
  comments: ProfileComment[];
  /** Where older posts and comments start, when there are more. */
  olderPosts: string | null;
  olderComments: string | null;
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
/** A linked X account shows while chosen, while the plan lasts, and while it is still linked. */
const X_SHOWN = `profile.x_shown = 1 AND (profile.role = 'admin' OR profile.plan_until > ?2)
  AND EXISTS (SELECT 1 FROM "account" WHERE "userId" = profile.user_id AND "providerId" = 'twitter' AND "accountId" = profile.x_id)`;

export async function profileByName(
  db: D1Database,
  name: string,
  /** Older posts or comments: what came before these places. */
  page: { postsBefore?: string | null; commentsBefore?: string | null } = {},
): Promise<ProfileLookup | null> {
  const owner = await db
    .prepare(
      `SELECT claimed.user_id, claimed.is_current, current.name AS current_name,
              profile.karma, profile.vote_karma, profile.created_at, profile.avatar_key,
              (SELECT name FROM usernames WHERE user_id = profile.invited_by AND is_current = 1
                 AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = profile.invited_by AND deleted_at IS NOT NULL)) AS inviter_name,
              (SELECT COUNT(*) FROM profiles WHERE invited_by = COALESCE(profile.owner_id, profile.user_id) AND deleted_at IS NULL) AS invited_total,
              profile.plan_until > ?2 AND profile.show_mark = 1 AS fan,
              CASE WHEN ${X_SHOWN} THEN profile.x_id END AS x_id,
              CASE WHEN ${X_SHOWN} THEN profile.x_handle END AS x_handle,
              (SELECT name FROM usernames WHERE user_id = profile.owner_id AND is_current = 1) AS owner_name,
              CASE WHEN profile.show_gift = 1 THEN
                (SELECT SUM(amount_cents - refunded_cents) FROM payments WHERE user_id = profile.user_id AND kind = 'fresh_start')
              END AS gift_cents,
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
      vote_karma: number;
      inviter_name: string | null;
      invited_total: number;
      created_at: number;
      avatar_key: string | null;
      fan: number | null;
      x_id: string | null;
      x_handle: string | null;
      owner_name: string | null;
      agent_name: string | null;
      gift_cents: number | null;
    }>();
  if (!owner) return null;
  if (owner.is_current !== 1) {
    return { kind: "renamed", username: owner.current_name };
  }

  const postsBefore = parseCursor(page.postsBefore);
  const commentsBefore = parseCursor(page.commentsBefore);
  // One more than shown, to know whether there are older ones.
  const [posts, comments, invited] = await db.batch([
    db
      .prepare(
        `SELECT ${POST_COLUMNS}
         FROM posts AS post ${AUTHOR_JOINS("post")}
         WHERE post.author_id = ?1
           AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
           AND (?3 IS NULL OR post.created_at < ?3 OR (post.created_at = ?3 AND post.id < ?4))
         ORDER BY post.created_at DESC, post.id DESC
         LIMIT ?2`,
      )
      .bind(owner.user_id, LISTING_LIMIT + 1, postsBefore?.at ?? null, postsBefore?.id ?? ""),
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
           AND (?3 IS NULL OR comment.created_at < ?3 OR (comment.created_at = ?3 AND comment.id < ?4))
         ORDER BY comment.created_at DESC, comment.id DESC
         LIMIT ?2`,
      )
      .bind(owner.user_id, LISTING_LIMIT + 1, commentsBefore?.at ?? null, commentsBefore?.id ?? ""),
    // Those this member invited, by name; an agent shows its owner's.
    db
      .prepare(
        `SELECT name.name FROM profiles AS invitee
         JOIN usernames AS name ON name.user_id = invitee.user_id AND name.is_current = 1
         WHERE invitee.invited_by = COALESCE((SELECT owner_id FROM profiles WHERE user_id = ?1), ?1)
           AND invitee.deleted_at IS NULL
         ORDER BY invitee.created_at DESC LIMIT 50`,
      )
      .bind(owner.user_id),
  ]);

  const cards = (posts.results as PostRow[]).slice(0, LISTING_LIMIT).map((row) => {
    const { description: _description, ...card } = toPublicPost(row);
    return card;
  });
  const listedRows = (
    comments.results as Array<{
      id: string;
      body: string;
      score: number;
      created_at: number;
      post_id: string;
      post_title: string;
    }>
  ).slice(0, LISTING_LIMIT);
  const listed = listedRows.map((row) => ({
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
      ...(owner.fan === 1 ? { fan: true } : {}),
      ...(owner.x_id && owner.x_handle ? { x: { id: owner.x_id, handle: owner.x_handle } } : {}),
      ...(owner.inviter_name ? { invitedBy: owner.inviter_name } : {}),
      ...(owner.gift_cents ? { giftCents: owner.gift_cents } : {}),
      ...(await termsOf(db, owner.user_id, Math.floor(Date.now() / 1000)).then((terms) => (terms.length > 0 ? { editorTerms: terms } : {}))),
      invited: { names: (invited!.results as Array<{ name: string }>).map((row) => row.name), total: owner.invited_total },
      inviteKarma: owner.karma - owner.vote_karma,
      posts: await withPlainMentions(db, cards, "excerpt"),
      comments: await withPlainMentions(db, listed, "body"),
      olderPosts: posts.results.length > LISTING_LIMIT ? profileCursor(cards[cards.length - 1]!) : null,
      olderComments: comments.results.length > LISTING_LIMIT ? profileCursor(listed[listed.length - 1]!) : null,
    },
  };
}
