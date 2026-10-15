import { newId } from "../ids";
import { KARMA_FLOOR, LOW_KARMA } from "../moderation";
import { postPath } from "../slug";
import { applyFreshStart } from "./fresh-starts.server";
import { karmaSql, scoreSql, trailFloors } from "./votes.server";

const DAY = 24 * 3600;

export const BAN_DURATIONS = {
  day: DAY,
  week: 7 * DAY,
  month: 30 * DAY,
  permanent: null,
} as const;

export type BanDuration = keyof typeof BAN_DURATIONS;

export type ModerationAction =
  | "remove_post"
  | "remove_comment"
  | "remove_comments"
  | "discard_votes"
  | "ban"
  | "unban"
  | "pin"
  | "unpin"
  | "restore"
  | "set_limits"
  | "reset_avatar"
  | "fresh_start"
  | "purge_media";

export type ModerationResult =
  | { ok: true; batchId: string; actionId: string }
  | { ok: false; reason: "not_found" | "not_allowed" | "already" };

function logAction(
  db: D1Database,
  entry: {
    id: string;
    batchId: string;
    actorId: string;
    action: ModerationAction;
    targetType: "post" | "comment" | "user" | "action";
    targetId: string;
    reason: string | null;
    now: number;
  },
  /** Written only when this SQL condition holds, so a refused change logs nothing. */
  when = "1",
  ...params: unknown[]
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO mod_actions (id, batch_id, actor_id, action, target_type, target_id, reason, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8 WHERE ${when}`,
    )
    .bind(
      entry.id,
      entry.batchId,
      entry.actorId,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.reason,
      entry.now,
      ...params,
    );
}

/** Marks a target's open reports handled, as acting on it handles them. */
function resolveReportsOn(db: D1Database, type: "post" | "comment" | "user", id: string, actorId: string, now: number) {
  return db
    .prepare(
      `UPDATE reports SET status = 'resolved', resolved_at = ?4, resolved_by = ?3
       WHERE target_type = ?1 AND target_id = ?2 AND status = 'open'`,
    )
    .bind(type, id, actorId, now);
}

/**
 * Recounts the scores of everything an account voted on, and the karma of
 * their authors, from the votes table. Used when its votes are discarded
 * or restored, so each counts exactly once either way.
 */
function recountVotesOf(db: D1Database, voterId: string): D1PreparedStatement[] {
  const voted = (type: "post" | "comment") =>
    `SELECT target_id FROM votes WHERE voter_id = ?1 AND target_type = '${type}'`;
  return [
    db.prepare(`UPDATE posts SET score = ${scoreSql("post", "posts.id")} WHERE id IN (${voted("post")})`).bind(voterId),
    db
      .prepare(`UPDATE comments SET score = ${scoreSql("comment", "comments.id")} WHERE id IN (${voted("comment")})`)
      .bind(voterId),
    // Every account sharing karma with an author whose items were voted on.
    db
      .prepare(
        `UPDATE profiles SET karma = ${karmaSql("profiles.user_id")}
         WHERE user_id IN (
           SELECT member.user_id FROM profiles AS member
           JOIN profiles AS author
             ON COALESCE(author.owner_id, author.user_id) IN (member.user_id, member.owner_id)
           WHERE author.user_id IN (
             SELECT author_id FROM posts WHERE id IN (${voted("post")})
             UNION SELECT author_id FROM comments WHERE id IN (${voted("comment")})))`,
      )
      .bind(voterId),
    trailFloors(db),
  ];
}

/**
 * Removes a post. It leaves the feed and profiles and its permalink becomes
 * [removed by moderator]; nothing is deleted, so it can be restored. A post
 * its author deleted cannot be removed: it is already gone for good.
 */
export async function removePost(
  db: D1Database,
  input: { postId: string; actorId: string; reason: string | null; now: number },
): Promise<ModerationResult> {
  const batchId = newId();
  const actionId = newId();
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE posts SET removed_batch_id = ?2
         WHERE id = ?1 AND removed_batch_id IS NULL AND deleted_at IS NULL`,
      )
      .bind(input.postId, batchId),
    logAction(
      db,
      { id: actionId, batchId, actorId: input.actorId, action: "remove_post", targetType: "post", targetId: input.postId, reason: input.reason, now: input.now },
      `EXISTS (SELECT 1 FROM posts WHERE id = ?9 AND removed_batch_id = ?2)`,
      input.postId,
    ),
    resolveReportsOn(db, "post", input.postId, input.actorId, input.now),
  ]);
  if (updated.meta.changes > 0) return { ok: true, batchId, actionId };
  const exists = await db.prepare(`SELECT 1 FROM posts WHERE id = ?1`).bind(input.postId).first();
  return { ok: false, reason: exists ? "already" : "not_found" };
}

/** Removes one comment, keeping its place and replies; restorable. */
export async function removeComment(
  db: D1Database,
  input: { commentId: string; actorId: string; reason: string | null; now: number },
): Promise<ModerationResult> {
  const batchId = newId();
  const actionId = newId();
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE comments SET removed_batch_id = ?2
         WHERE id = ?1 AND removed_batch_id IS NULL AND deleted_at IS NULL`,
      )
      .bind(input.commentId, batchId),
    logAction(
      db,
      { id: actionId, batchId, actorId: input.actorId, action: "remove_comment", targetType: "comment", targetId: input.commentId, reason: input.reason, now: input.now },
      `EXISTS (SELECT 1 FROM comments WHERE id = ?9 AND removed_batch_id = ?2)`,
      input.commentId,
    ),
    resolveReportsOn(db, "comment", input.commentId, input.actorId, input.now),
  ]);
  if (updated.meta.changes > 0) return { ok: true, batchId, actionId };
  const exists = await db.prepare(`SELECT 1 FROM comments WHERE id = ?1`).bind(input.commentId).first();
  return { ok: false, reason: exists ? "already" : "not_found" };
}

/** What a ban's two options would touch, for its confirmation. */
export async function banPreview(db: D1Database, userId: string): Promise<{ comments: number; votes: number }> {
  const row = await db
    .prepare(
      `SELECT
         (SELECT COUNT(*) FROM comments WHERE author_id = ?1
            AND removed_batch_id IS NULL AND deleted_at IS NULL) AS comments,
         (SELECT COUNT(*) FROM votes WHERE voter_id = ?1 AND invalidated_batch_id IS NULL) AS votes`,
    )
    .bind(userId)
    .first<{ comments: number; votes: number }>();
  return { comments: row?.comments ?? 0, votes: row?.votes ?? 0 };
}

/**
 * Bans an account for a while or for good, with a reason it is shown. It
 * and its agent can then read but not take part. Optionally, in the same
 * batch, removes all its comments, keeping other people's replies, and
 * discards its votes, recounting every score and karma they touched. Admins
 * cannot be banned, nor can anyone ban themselves.
 */
export async function banUser(
  db: D1Database,
  input: {
    userId: string;
    actorId: string;
    duration: BanDuration;
    reason: string | null;
    removeComments: boolean;
    discardVotes: boolean;
    now: number;
  },
): Promise<ModerationResult> {
  if (input.userId === input.actorId) return { ok: false, reason: "not_allowed" };
  const length = BAN_DURATIONS[input.duration];
  const until = length === null ? null : input.now + length;
  const batchId = newId();
  const actionId = newId();
  const base = { batchId, actorId: input.actorId, targetType: "user" as const, targetId: input.userId, reason: input.reason, now: input.now };
  // Every step after the ban itself runs only if the ban landed, which its
  // batch on the profile says.
  const banned = `EXISTS (SELECT 1 FROM profiles WHERE user_id = ?9 AND ban_batch_id = ?2 AND role <> 'admin')`;

  const statements: D1PreparedStatement[] = [
    db
      .prepare(
        `UPDATE profiles SET banned_at = ?2, banned_until = ?3, ban_reason = ?4, ban_batch_id = ?5
         WHERE user_id = ?1 AND role <> 'admin' AND deleted_at IS NULL`,
      )
      .bind(input.userId, input.now, until, input.reason, batchId),
    logAction(db, { ...base, id: actionId, action: "ban" }, banned, input.userId),
  ];
  if (input.removeComments) {
    statements.push(
      db
        .prepare(
          `UPDATE comments SET removed_batch_id = ?2
           WHERE author_id = ?1 AND removed_batch_id IS NULL AND deleted_at IS NULL
             AND EXISTS (SELECT 1 FROM profiles WHERE user_id = ?1 AND ban_batch_id = ?2)`,
        )
        .bind(input.userId, batchId),
      logAction(db, { ...base, id: newId(), action: "remove_comments" }, banned, input.userId),
    );
  }
  if (input.discardVotes) {
    statements.push(
      db
        .prepare(
          `UPDATE votes SET invalidated_batch_id = ?2
           WHERE voter_id = ?1 AND invalidated_batch_id IS NULL
             AND EXISTS (SELECT 1 FROM profiles WHERE user_id = ?1 AND ban_batch_id = ?2)`,
        )
        .bind(input.userId, batchId),
      ...recountVotesOf(db, input.userId),
      logAction(db, { ...base, id: newId(), action: "discard_votes" }, banned, input.userId),
    );
  }
  statements.push(resolveReportsOn(db, "user", input.userId, input.actorId, input.now));

  const [updated] = await db.batch(statements);
  if (updated.meta.changes > 0) return { ok: true, batchId, actionId };
  const target = await db.prepare(`SELECT role FROM profiles WHERE user_id = ?1 AND deleted_at IS NULL`).bind(input.userId).first<{ role: string }>();
  return { ok: false, reason: target ? "not_allowed" : "not_found" };
}

/**
 * Lifts a ban now. Comments and votes a ban removed stay removed until
 * restored on their own, from the log.
 */
export async function unbanUser(
  db: D1Database,
  input: { userId: string; actorId: string; now: number },
): Promise<ModerationResult> {
  const batchId = newId();
  const actionId = newId();
  const [updated] = await db.batch([
    db
      .prepare(
        `UPDATE profiles SET banned_at = NULL, banned_until = NULL, ban_reason = NULL, ban_batch_id = NULL
         WHERE user_id = ?1 AND banned_at IS NOT NULL`,
      )
      .bind(input.userId),
    logAction(
      db,
      { id: actionId, batchId, actorId: input.actorId, action: "unban", targetType: "user", targetId: input.userId, reason: null, now: input.now },
      `EXISTS (SELECT 1 FROM profiles WHERE user_id = ?9 AND banned_at IS NULL)`,
      input.userId,
    ),
  ]);
  return updated.meta.changes > 0 ? { ok: true, batchId, actionId } : { ok: false, reason: "already" };
}

/**
 * Undoes one logged action: a removal, the comment removal or vote discard
 * of a ban, or the ban itself while it is still the one in force. Only
 * what that action did is undone, so a removal by another action, or the
 * author's own deletion, stays as it is. Undone actions are marked, and the
 * restoration is logged.
 */
export async function revertAction(
  db: D1Database,
  input: { actionId: string; actorId: string; now: number },
): Promise<ModerationResult> {
  const action = await db
    .prepare(
      `SELECT id, batch_id, action, target_id, created_at FROM mod_actions
       WHERE id = ?1 AND reverted_at IS NULL`,
    )
    .bind(input.actionId)
    .first<{ id: string; batch_id: string; action: ModerationAction; target_id: string; created_at: number }>();
  if (!action) return { ok: false, reason: "not_found" };

  let undo: D1PreparedStatement[];
  switch (action.action) {
    case "remove_post":
      undo = [db.prepare(`UPDATE posts SET removed_batch_id = NULL WHERE id = ?1 AND removed_batch_id = ?2`).bind(action.target_id, action.batch_id)];
      break;
    case "remove_comment":
      undo = [db.prepare(`UPDATE comments SET removed_batch_id = NULL WHERE id = ?1 AND removed_batch_id = ?2`).bind(action.target_id, action.batch_id)];
      break;
    case "remove_comments":
      undo = [db.prepare(`UPDATE comments SET removed_batch_id = NULL WHERE removed_batch_id = ?1`).bind(action.batch_id)];
      break;
    case "discard_votes":
      undo = [
        db.prepare(`UPDATE votes SET invalidated_batch_id = NULL WHERE invalidated_batch_id = ?1`).bind(action.batch_id),
        ...recountVotesOf(db, action.target_id),
      ];
      break;
    case "ban":
      undo = [
        db
          .prepare(
            // Only the ban this action made: a later one has its own batch.
            `UPDATE profiles SET banned_at = NULL, banned_until = NULL, ban_reason = NULL, ban_batch_id = NULL
             WHERE user_id = ?1 AND ban_batch_id = ?2`,
          )
          .bind(action.target_id, action.batch_id),
      ];
      break;
    default:
      return { ok: false, reason: "not_allowed" };
  }

  const restoreId = newId();
  await db.batch([
    ...undo,
    db.prepare(`UPDATE mod_actions SET reverted_at = ?2 WHERE id = ?1 AND reverted_at IS NULL`).bind(action.id, input.now),
    logAction(db, { id: restoreId, batchId: newId(), actorId: input.actorId, action: "restore", targetType: "action", targetId: action.id, reason: null, now: input.now }),
  ]);
  return { ok: true, batchId: action.batch_id, actionId: restoreId };
}

/**
 * The single removal of a post or comment still in force, to restore it in
 * place. Comments a ban removed together are restored together, from the log.
 */
export async function activeRemoval(db: D1Database, type: "post" | "comment", id: string): Promise<string | null> {
  const table = type === "post" ? "posts" : "comments";
  const row = await db
    .prepare(
      `SELECT action.id FROM ${table} AS item
       JOIN mod_actions AS action ON action.batch_id = item.removed_batch_id
       WHERE item.id = ?1 AND action.reverted_at IS NULL
         AND action.action IN ('remove_post', 'remove_comment')
       LIMIT 1`,
    )
    .bind(id)
    .first<{ id: string }>();
  return row?.id ?? null;
}

/**
 * Sets how many posts an account may publish per rolling 24 hours: a number,
 * null for no limit, or undefined to go back to the board's default. This is
 * how the house agent posts more than once a day.
 */
export async function setPostingLimit(
  db: D1Database,
  input: { userId: string; actorId: string; postsPerDay: number | null | undefined; now: number },
): Promise<boolean> {
  const value = input.postsPerDay === undefined ? "default" : input.postsPerDay === null ? "unlimited" : String(input.postsPerDay);
  const update =
    input.postsPerDay === undefined
      ? db.prepare(`UPDATE profiles SET limits = json_remove(COALESCE(limits, '{}'), '$.postsPerDay') WHERE user_id = ?1`).bind(input.userId)
      : db
          .prepare(`UPDATE profiles SET limits = json_set(COALESCE(limits, '{}'), '$.postsPerDay', json(?2)) WHERE user_id = ?1`)
          .bind(input.userId, JSON.stringify(input.postsPerDay));
  const [updated] = await db.batch([
    update,
    logAction(
      db,
      { id: newId(), batchId: newId(), actorId: input.actorId, action: "set_limits", targetType: "user", targetId: input.userId, reason: `postsPerDay: ${value}`, now: input.now },
      `EXISTS (SELECT 1 FROM profiles WHERE user_id = ?9)`,
      input.userId,
    ),
  ]);
  return updated.meta.changes > 0;
}

/**
 * A fresh start granted on appeal: the member and their agent take part
 * again, as after a paid one, with nothing paid. Given for an agent, it is
 * its owner's, since they share karma.
 */
export async function grantFreshStart(
  db: D1Database,
  input: { userId: string; actorId: string; reason: string | null; now: number },
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT COALESCE(owner_id, user_id) AS member FROM profiles WHERE user_id = ?1 AND deleted_at IS NULL`)
    .bind(input.userId)
    .first<{ member: string }>();
  if (!row) return false;
  const actionId = newId();
  const applied = await applyFreshStart(db, { id: actionId, userId: row.member, source: "admin", now: input.now });
  if (applied) {
    await logAction(db, { id: actionId, batchId: newId(), actorId: input.actorId, action: "fresh_start", targetType: "user", targetId: row.member, reason: input.reason, now: input.now }).run();
  }
  return applied;
}

/**
 * Deletes a removed post's files for good: its upload, its poster or
 * snapshot, for a takedown. Removal alone keeps them, so the post can be
 * restored; after this it can be restored without them. Copies already in
 * the media domain's cache last until they expire or are purged there.
 * Returns the deleted keys, or null when the post is not removed.
 */
export async function purgePostMedia(
  db: D1Database,
  bucket: R2Bucket,
  input: { postId: string; actorId: string; now: number },
): Promise<string[] | null> {
  const row = await db
    .prepare(`SELECT thumb_key, media_key FROM posts WHERE id = ?1 AND removed_batch_id IS NOT NULL`)
    .bind(input.postId)
    .first<{ thumb_key: string | null; media_key: string | null }>();
  if (!row) return null;
  const keys = [row.thumb_key, row.media_key].filter((key): key is string => key !== null);
  await db.batch([
    db.prepare(`UPDATE posts SET thumb_key = NULL, media_key = NULL WHERE id = ?1`).bind(input.postId),
    db.prepare(`DELETE FROM images WHERE key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)),
    logAction(db, { id: newId(), batchId: newId(), actorId: input.actorId, action: "purge_media", targetType: "post", targetId: input.postId, reason: null, now: input.now }),
  ]);
  if (keys.length > 0) await bucket.delete(keys);
  return keys;
}

/** Puts an account back on its letter avatar and deletes the photo copy. */
export async function resetAvatar(
  db: D1Database,
  bucket: R2Bucket,
  input: { userId: string; actorId: string; now: number },
): Promise<boolean> {
  const row = await db.prepare(`SELECT avatar_key FROM profiles WHERE user_id = ?1`).bind(input.userId).first<{ avatar_key: string | null }>();
  if (!row?.avatar_key) return false;
  await db.batch([
    db.prepare(`UPDATE profiles SET avatar_key = NULL WHERE user_id = ?1`).bind(input.userId),
    db.prepare(`DELETE FROM images WHERE key = ?1`).bind(row.avatar_key),
    logAction(db, { id: newId(), batchId: newId(), actorId: input.actorId, action: "reset_avatar", targetType: "user", targetId: input.userId, reason: null, now: input.now }),
  ]);
  await bucket.delete(row.avatar_key);
  return true;
}

/** One account as the admin users list shows it. */
export interface AdminUser {
  id: string;
  username: string;
  karma: number;
  role: "user" | "admin";
  agent: boolean;
  joinedAt: number;
  ban: { reason: string | null; until: number | null } | null;
  /** Karma at or below its floor makes the account read-only, unless it is an admin's. */
  floor: number;
  readOnly: boolean;
  /** Posts per day: undefined for the default, null for no limit. */
  postsPerDay: number | null | undefined;
  hasPhoto: boolean;
}

export type UserFilter = "all" | "banned" | "low";

/**
 * Accounts for the admin users list: newest first, or by name; banned ones
 * only; or the lowest karma first, at or below the low-karma line.
 */
export async function adminUsers(
  db: D1Database,
  input: { query: string; filter: UserFilter; now: number; limit?: number },
): Promise<AdminUser[]> {
  const banned = `profile.banned_at IS NOT NULL AND (profile.banned_until IS NULL OR profile.banned_until > ?2)`;
  const where = [
    "profile.deleted_at IS NULL",
    input.query ? `profile.user_id IN (SELECT user_id FROM usernames WHERE name LIKE ?1 ESCAPE '\\')` : "1",
    input.filter === "banned" ? banned : input.filter === "low" ? `profile.karma <= ${LOW_KARMA}` : "1",
  ].join(" AND ");
  const order = input.filter === "low" ? "profile.karma ASC" : "profile.created_at DESC";
  const pattern = `%${input.query.toLowerCase().replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
  const { results } = await db
    .prepare(
      `SELECT profile.user_id, name.name, profile.karma, profile.role, profile.owner_id IS NOT NULL AS agent,
         profile.created_at, profile.ban_reason, profile.banned_until, ${banned} AS banned,
         json_extract(profile.limits, '$.postsPerDay') AS posts_per_day,
         json_type(profile.limits, '$.postsPerDay') AS limit_type,
         profile.avatar_key IS NOT NULL AS has_photo,
         COALESCE(profile.karma_floor, ${KARMA_FLOOR}) AS floor,
         COALESCE(owner.role, profile.role) = 'admin' AS exempt
       FROM profiles AS profile
       JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
       LEFT JOIN profiles AS owner ON owner.user_id = profile.owner_id
       WHERE ${where}
       ORDER BY ${order}
       LIMIT ?3`,
    )
    .bind(pattern, input.now, input.limit ?? 50)
    .all<{
      user_id: string;
      name: string;
      karma: number;
      role: "user" | "admin";
      agent: number;
      created_at: number;
      ban_reason: string | null;
      banned_until: number | null;
      banned: number;
      posts_per_day: number | null;
      limit_type: string | null;
      has_photo: number;
      floor: number;
      exempt: number;
    }>();
  return results.map((row) => ({
    id: row.user_id,
    username: row.name,
    karma: row.karma,
    role: row.role,
    agent: row.agent === 1,
    joinedAt: row.created_at,
    ban: row.banned ? { reason: row.ban_reason, until: row.banned_until } : null,
    floor: row.floor,
    readOnly: row.exempt === 0 && row.karma <= row.floor,
    postsPerDay: row.limit_type === null ? undefined : row.limit_type === "null" ? null : row.posts_per_day,
    hasPhoto: row.has_photo === 1,
  }));
}

/** One entry of the moderation log, with what it acted on. */
export interface LogEntry {
  id: string;
  action: ModerationAction;
  actor: string | null;
  target: { type: string; id: string; label: string; link: string | null };
  reason: string | null;
  at: number;
  revertedAt: number | null;
  /** Whether Undo is offered: a removal, a ban's parts, or a ban. */
  revertible: boolean;
}

const REVERTIBLE = new Set<ModerationAction>(["remove_post", "remove_comment", "remove_comments", "discard_votes", "ban"]);

/** The moderation log, newest first, each entry named for people to read. */
export async function moderationLog(db: D1Database, input: { before?: number; limit?: number } = {}): Promise<LogEntry[]> {
  const { results } = await db
    .prepare(
      `SELECT action.id, action.action, action.target_type, action.target_id, action.reason,
         action.created_at, action.reverted_at, actor.name AS actor,
         CASE action.target_type
           WHEN 'post' THEN (SELECT title FROM posts WHERE id = action.target_id)
           WHEN 'comment' THEN (SELECT substr(body, 1, 80) FROM comments WHERE id = action.target_id)
           WHEN 'user' THEN (SELECT name FROM usernames WHERE user_id = action.target_id AND is_current = 1)
           WHEN 'action' THEN (SELECT original.action FROM mod_actions AS original WHERE original.id = action.target_id)
         END AS label,
         CASE action.target_type
           WHEN 'comment' THEN (SELECT post_id FROM comments WHERE id = action.target_id)
           WHEN 'post' THEN action.target_id
         END AS post_id,
         (SELECT title FROM posts WHERE id = (SELECT post_id FROM comments WHERE id = action.target_id)) AS post_title
       FROM mod_actions AS action
       LEFT JOIN usernames AS actor ON actor.user_id = action.actor_id AND actor.is_current = 1
       WHERE action.created_at < ?1
       ORDER BY action.created_at DESC, action.id DESC
       LIMIT ?2`,
    )
    .bind(input.before ?? Number.MAX_SAFE_INTEGER, input.limit ?? 100)
    .all<{
      id: string;
      action: ModerationAction;
      target_type: string;
      target_id: string;
      reason: string | null;
      created_at: number;
      reverted_at: number | null;
      actor: string | null;
      label: string | null;
      post_id: string | null;
      post_title: string | null;
    }>();
  return results.map((row) => {
    let link: string | null = null;
    if (row.target_type === "post" && row.post_id) link = postPath({ id: row.post_id, title: row.label ?? "" });
    if (row.target_type === "comment" && row.post_id) link = `${postPath({ id: row.post_id, title: row.post_title ?? "" })}#c-${row.target_id}`;
    if (row.target_type === "user" && row.label) link = `/u/${row.label}`;
    return {
      id: row.id,
      action: row.action,
      actor: row.actor,
      target: { type: row.target_type, id: row.target_id, label: row.label ?? row.target_id, link },
      reason: row.reason,
      at: row.created_at,
      revertedAt: row.reverted_at,
      revertible: REVERTIBLE.has(row.action) && row.reverted_at === null,
    };
  });
}
