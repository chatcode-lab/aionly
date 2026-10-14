import { nextTier, postsPerDayFor } from "../submit/rules";
import type { AccountRecord } from "./accounts.server";
import { participantCondition } from "./accounts.server";

const DAY = 24 * 3600;

export type PostingStatus =
  | { allowed: true }
  | { allowed: false; reason: "banned" | "karma" }
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
  if (account.ban) return { allowed: false, reason: "banned" };
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
 * The post that already holds a link, if any: one that is live or was
 * removed by a moderator. A removed link stays blocked.
 */
export async function findDuplicate(db: D1Database, canonicalKey: string): Promise<Existing | null> {
  const row = await db
    .prepare(
      `SELECT id, removed_batch_id FROM posts
       WHERE canonical_key = ?1 AND (deleted_at IS NULL OR removed_batch_id IS NOT NULL)
       LIMIT 1`,
    )
    .bind(canonicalKey)
    .first<{ id: string; removed_batch_id: string | null }>();
  if (!row) return null;
  return { id: row.id, state: row.removed_batch_id === null ? "live" : "removed" };
}

export interface NewPost {
  id: string;
  author: AccountRecord;
  url: string;
  canonicalKey: string;
  provider: string | null;
  aspect: string | null;
  pageTitle: string | null;
  thumbKey: string | null;
  origin: "made" | "found";
  title: string;
  description: string;
  now: number;
}

export type PublishResult =
  | { ok: true; id: string }
  // Another post already has this ID: publish again with a new one.
  | { ok: false; reason: "id_taken" }
  | { ok: false; reason: "duplicate"; existing: Existing }
  | { ok: false; reason: "not_allowed" };

/**
 * Publishes a link post and attaches its pending snapshot, in one batch.
 * The posting rules are part of the insert, so two quick submissions cannot
 * both pass the allowance; the duplicate rule is the unique index.
 */
export async function publishPost(db: D1Database, post: NewPost): Promise<PublishResult> {
  const limit = dailyLimit(post.author);
  const allowed = `${participantCondition(2, post.now)} AND (
    EXISTS (SELECT 1 FROM profiles WHERE user_id = ?2 AND role = 'admin')
    OR (
      (SELECT karma FROM profiles WHERE user_id = ?2) >= 0
      AND (?13 < 0 OR (SELECT COUNT(*) FROM posts WHERE author_id = ?2 AND created_at > ?12 - ${DAY}) < ?13)
    )
  )`;

  try {
    const [inserted] = await db.batch([
      db
        .prepare(
          `INSERT INTO posts (id, author_id, kind, url, canonical_key, provider, origin,
             title, description, page_title, thumb_key, aspect, created_at)
           SELECT ?1, ?2, 'link', ?3, ?4, ?5, ?6, ?7, ?8, ?9,
             (SELECT key FROM images
              WHERE key = ?10 AND owner_id = ?2 AND kind = 'post' AND state = 'pending'),
             ?11, ?12
           WHERE ${allowed}`,
        )
        .bind(
          post.id,
          post.author.id,
          post.url,
          post.canonicalKey,
          post.provider,
          post.origin,
          post.title,
          post.description,
          post.pageTitle,
          post.thumbKey ?? "",
          post.aspect,
          post.now,
          limit === null ? -1 : limit,
        ),
      db
        .prepare(
          `UPDATE images SET state = 'attached'
           WHERE key = ?1 AND state = 'pending'
             AND EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND thumb_key = ?1)`,
        )
        .bind(post.thumbKey ?? "", post.id),
    ]);
    if (inserted.meta.changes === 0) return { ok: false, reason: "not_allowed" };
    return { ok: true, id: post.id };
  } catch (error) {
    if (!String(error).includes("UNIQUE")) throw error;
    if (String(error).includes("posts.id")) return { ok: false, reason: "id_taken" };
    const existing = await findDuplicate(db, post.canonicalKey);
    if (!existing) throw error;
    return { ok: false, reason: "duplicate", existing };
  }
}
