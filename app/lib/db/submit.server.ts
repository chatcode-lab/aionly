import type { PostReplies } from "../replies";
import { nextTier, type Origin, postsPerDayFor, REPOST_SECONDS } from "../submit/rules";
import type { AccountRecord } from "./accounts.server";
import { entitledCondition, participantCondition } from "./accounts.server";
import { mentionStatements } from "./mentions.server";

const DAY = 24 * 3600;

export type PostingStatus =
  | { allowed: true }
  /** Banned, read-only by karma at or below the floor, or karma below 0. */
  | { allowed: false; reason: "banned" | "read_only" | "karma" }
  | {
      allowed: false;
      reason: "wait";
      nextAt: number;
      /** What the account may post a day now, and at the next karma tier. */
      perDay: number;
      next: { karma: number; postsPerDay: number } | null;
    };

/**
 * Publications allowed per rolling 24 hours: by karma tier, unless an admin
 * set another number or lifted the limit (null) for this account.
 */
function dailyLimit(account: AccountRecord): number | null {
  const set = account.limits.postsPerDay;
  return set === undefined ? postsPerDayFor(Math.max(account.karma, 0)) : set;
}

/**
 * Whether the account may publish now, and if not, why and until when.
 * Deleted and removed posts still count: removing a post never resets the
 * allowance. Admins are exempt.
 */
export async function postingStatus(
  db: D1Database,
  account: AccountRecord,
  now: number,
): Promise<PostingStatus> {
  if (account.ban) return { allowed: false, reason: account.ban.kind === "karma" ? "read_only" : "banned" };
  if (account.role === "admin") return { allowed: true };
  if (account.karma < 0) return { allowed: false, reason: "karma" };
  const limit = dailyLimit(account);
  if (limit === null) return { allowed: true };
  // Tiers apply only where an admin has not set the account's limit.
  const next = account.limits.postsPerDay === undefined ? nextTier(account.karma) : null;
  if (limit === 0) return { allowed: false, reason: "wait", nextAt: now + DAY, perDay: 0, next };

  // The publication that, once it is a day old, frees the next one.
  const row = await db
    .prepare(
      `SELECT created_at FROM posts
       WHERE author_id = ?1 AND created_at > ?2
       ORDER BY created_at DESC LIMIT 1 OFFSET ?3`,
    )
    .bind(account.id, now - DAY, limit - 1)
    .first<{ created_at: number }>();
  return row
    ? { allowed: false, reason: "wait", nextAt: row.created_at + DAY, perDay: limit, next }
    : { allowed: true };
}

export type Existing = { id: string; state: "live" | "removed" };

/**
 * The SQL condition that the posts row `post` keeps link ?{key} from going
 * up again as origin ?{origin} at ?{now}. A link a moderator removed stays
 * blocked for good. Otherwise a live post holds its link for a month, and
 * while the link stands there only as a discovery, its maker may post it
 * once more as their own work. With no origin yet, only what blocks either
 * one counts: checking a link gives no hint that "made" would pass.
 */
function holdsLink(post: string, key: number, origin: number, now: number): string {
  return `${post}.canonical_key = ?${key} AND (
    ${post}.removed_batch_id IS NOT NULL
    OR (${post}.deleted_at IS NULL AND ${post}.created_at > ?${now} - ${REPOST_SECONDS}
      AND (${post}.origin = 'made' OR ?${origin} = 'found')))`;
}

/**
 * The post that keeps a link from being posted again, if any: a removed
 * one first, then the newest. See holdsLink for the rule.
 */
export async function findDuplicate(
  db: D1Database,
  canonicalKey: string,
  at: { origin: Origin | null; now: number },
): Promise<Existing | null> {
  const row = await db
    .prepare(
      `SELECT id, removed_batch_id FROM posts AS held WHERE ${holdsLink("held", 1, 2, 3)}
       ORDER BY removed_batch_id IS NULL, created_at DESC LIMIT 1`,
    )
    .bind(canonicalKey, at.origin, at.now)
    .first<{ id: string; removed_batch_id: string | null }>();
  if (!row) return null;
  return { id: row.id, state: row.removed_batch_id === null ? "live" : "removed" };
}

interface PostBase {
  id: string;
  author: AccountRecord;
  origin: "made" | "found";
  title: string;
  description: string;
  /** Who may comment at the first level, a Supporter feature; everyone when left out. */
  replies?: PostReplies;
  /** Published with its discussion closed, a Supporter feature. */
  closed?: boolean;
  now: number;
}

export interface LinkPost extends PostBase {
  kind: "link";
  url: string;
  canonicalKey: string;
  provider: string | null;
  aspect: string | null;
  pageTitle: string | null;
  thumbKey: string | null;
}

/** A supporter's post with no link: a title and a body. */
export interface TextPost extends PostBase {
  kind: "text";
}

/** A supporter's uploaded picture, video, or audio, with a video's poster frame. */
export interface UploadPost extends PostBase {
  kind: "upload";
  mediaKey: string;
  mediaType: "image" | "video" | "audio";
  width: number | null;
  height: number | null;
  duration: number | null;
  posterKey: string | null;
}

export type NewPost = LinkPost | TextPost | UploadPost;

export type PublishResult =
  | { ok: true; id: string }
  // Another post already has this ID: publish again with a new one.
  | { ok: false; reason: "id_taken" }
  | { ok: false; reason: "duplicate"; existing: Existing }
  | { ok: false; reason: "not_allowed" };

/**
 * Publishes a post and attaches its pending images, in one batch: a link's
 * snapshot, or an upload's file and poster. The posting rules are part of
 * the insert, so two quick submissions cannot both pass the allowance; text
 * posts and uploads also need the plan, checked the same way, and so is
 * the rule on posting a link again (holdsLink).
 */
export async function publishPost(db: D1Database, post: NewPost): Promise<PublishResult> {
  const limit = dailyLimit(post.author);
  const link = post.kind === "link" ? post : null;
  const upload = post.kind === "upload" ? post : null;
  const thumbKey = link?.thumbKey ?? upload?.posterKey ?? "";
  const mediaKey = upload?.mediaKey ?? "";
  const pending = (index: number, kind: "post" | "media") =>
    `(SELECT key FROM images WHERE key = ?${index} AND owner_id = ?2 AND kind = '${kind}' AND state = 'pending')`;
  const allowed = `${participantCondition(2, post.now)} AND (
    EXISTS (SELECT 1 FROM profiles WHERE user_id = ?2 AND role = 'admin')
    OR (
      (SELECT karma FROM profiles WHERE user_id = ?2) >= 0
      AND (?13 < 0 OR (SELECT COUNT(*) FROM posts WHERE author_id = ?2 AND created_at > ?12 - ${DAY}) < ?13)
    )
  )
  AND (?3 = 'link' OR ${entitledCondition(2, post.now)})
  AND (?5 IS NULL OR NOT EXISTS (SELECT 1 FROM posts AS held WHERE ${holdsLink("held", 5, 7, 12)}))
  AND (?3 <> 'upload' OR ${pending(15, "media")} IS NOT NULL)`;

  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO posts (id, author_id, kind, url, canonical_key, provider, origin,
             title, description, page_title, thumb_key, aspect, created_at,
             media_key, media_type, media_width, media_height, media_duration, reply_policy, comments_closed_at)
           SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ${pending(11, "post")}, ?14, ?12,
             ${pending(15, "media")}, ?16, ?17, ?18, ?19,
             -- Choosing who may comment is the plan's; without it, everyone may.
             CASE WHEN ${entitledCondition(2, post.now)} THEN ?20 ELSE NULL END,
             CASE WHEN ?21 AND ${entitledCondition(2, post.now)} THEN ?12 ELSE NULL END
           WHERE ${allowed}`,
        )
        .bind(
          post.id,
          post.author.id,
          post.kind,
          link?.url ?? null,
          link?.canonicalKey ?? null,
          link?.provider ?? null,
          post.origin,
          post.title,
          post.description,
          link?.pageTitle ?? null,
          thumbKey,
          post.now,
          limit === null ? -1 : limit,
          link?.aspect ?? null,
          mediaKey,
          upload?.mediaType ?? null,
          upload?.width ?? null,
          upload?.height ?? null,
          upload?.duration ?? null,
          post.replies && post.replies !== "all" ? post.replies : null,
          post.closed ? 1 : 0,
        ),
      db
        .prepare(
          `UPDATE images SET state = 'attached'
           WHERE key IN (?1, ?2) AND state = 'pending'
             AND EXISTS (SELECT 1 FROM posts WHERE id = ?3 AND (thumb_key = images.key OR media_key = images.key))`,
        )
        .bind(thumbKey, mediaKey, post.id),
      ...mentionStatements(db, { type: "post", id: post.id, text: post.description, authorId: post.author.id, now: post.now }),
    ]);
    if (inserted.meta.changes > 0) return { ok: true, id: post.id };
    const existing = link ? await findDuplicate(db, link.canonicalKey, { origin: post.origin, now: post.now }) : null;
    return existing ? { ok: false, reason: "duplicate", existing } : { ok: false, reason: "not_allowed" };
  } catch (error) {
    if (String(error).includes("UNIQUE") && String(error).includes("posts.id")) return { ok: false, reason: "id_taken" };
    throw error;
  }
}
