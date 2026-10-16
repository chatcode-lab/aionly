import { participantCondition } from "./accounts.server";
import { settingSql } from "./setting-sql.server";

export type TargetType = "post" | "comment";
export type VoteValue = -1 | 0 | 1;

const TABLE: Record<TargetType, string> = { post: "posts", comment: "comments" };

/**
 * An item's net score, summed from its votes. Votes discarded by a ban do
 * not count. `item` is the SQL for the item's ID.
 */
export function scoreSql(type: TargetType, item: string): string {
  return `(SELECT COALESCE(SUM(value), 0) FROM votes
    WHERE target_type = '${type}' AND target_id = ${item}
      AND invalidated_batch_id IS NULL)`;
}

/**
 * The accounts that share one karma with the account `account` (SQL for its
 * ID): a member and their agent. An agent's karma is its owner's.
 */
export function karmaGroupSql(account: string): string {
  const root = `COALESCE((SELECT karma_root.owner_id FROM profiles AS karma_root
    WHERE karma_root.user_id = ${account}), ${account})`;
  return `(SELECT member.user_id FROM profiles AS member
    WHERE member.user_id = ${root} OR member.owner_id = ${root})`;
}

/**
 * An account's karma: every counted vote on the posts and comments of its
 * karma group, including ones since removed or deleted. `user` is the SQL
 * for its ID.
 */
export function karmaSql(user: string): string {
  // CROSS JOIN fixes the order: the group's own items by their author
  // index, then each item's votes. Left to choose, SQLite scans every vote.
  const received = (type: TargetType) => `COALESCE((
    SELECT SUM(vote.value) FROM ${TABLE[type]} AS item
    CROSS JOIN votes AS vote
      ON vote.target_type = '${type}' AND vote.target_id = item.id
    WHERE item.author_id IN ${karmaGroupSql(user)} AND vote.invalidated_batch_id IS NULL
  ), 0)`;
  return `(${received("post")} + ${received("comment")})`;
}

/**
 * Raises the floor of each account that had a fresh start as its karma
 * rises, keeping the room below it, until the usual floor applies again
 * (see trailingFloor). Runs after every karma recount, in the same batch,
 * for the accounts that recount touched (`holders`, an SQL list with its
 * bindings), and writes only floors that change.
 */
export function trailFloors(db: D1Database, holders: string, ...binds: unknown[]): D1PreparedStatement {
  const room = settingSql("fresh_start_room");
  const next = `CASE WHEN karma - ${room} >= ${settingSql("karma_floor")} THEN NULL
    ELSE MAX(karma_floor, karma - ${room}) END`;
  return db
    .prepare(
      `UPDATE profiles SET karma_floor = ${next}
       WHERE user_id IN ${holders} AND karma_floor IS NOT NULL AND karma_floor IS NOT ${next}`,
    )
    .bind(...binds);
}

/**
 * What a member's invitees add to their karma: the setting's share of each
 * one's vote karma, rounded down, from those above zero. `root` is the SQL
 * for the member's ID. Invitees' own shares never pass further up.
 */
export function inviteShareSql(root: string): string {
  return `COALESCE((SELECT SUM(invitee.vote_karma * ${settingSql("invite_share_percent")} / 100) FROM profiles AS invitee
    WHERE invitee.invited_by = ${root} AND invitee.vote_karma > 0 AND invitee.deleted_at IS NULL), 0)`;
}

/** An account's karma from its stored vote karma and its group's invitees. */
const TOTAL_KARMA = `vote_karma + ${inviteShareSql("COALESCE(profiles.owner_id, profiles.user_id)")}`;

/**
 * Recounts karma for the accounts `holders` (an SQL list, with its
 * bindings): their vote karma from the votes table, their karma with their
 * invitees' share, then the karma of whoever invited them, whose share just
 * moved; each floor follows. Statements for the batch that changed votes.
 */
export function recountKarma(db: D1Database, holders: string, ...binds: unknown[]): D1PreparedStatement[] {
  const invited = `(SELECT invited_by FROM profiles WHERE user_id IN ${holders} AND invited_by IS NOT NULL)`;
  const inviters = `(SELECT member.user_id FROM profiles AS member
    WHERE member.user_id IN ${invited} OR member.owner_id IN ${invited})`;
  return [
    db.prepare(`UPDATE profiles SET vote_karma = ${karmaSql("profiles.user_id")} WHERE user_id IN ${holders}`).bind(...binds),
    db.prepare(`UPDATE profiles SET karma = ${TOTAL_KARMA} WHERE user_id IN ${holders}`).bind(...binds),
    db.prepare(`UPDATE profiles SET karma = ${TOTAL_KARMA} WHERE user_id IN ${inviters}`).bind(...binds),
    trailFloors(db, holders, ...binds),
    trailFloors(db, inviters, ...binds),
  ];
}

/**
 * Recounts what a change of settings moves, for every account: karma from
 * what is stored, when the invitees' share changed (`karma`), and the
 * floors of fresh starts, which trail it.
 */
export function recountAllKarma(db: D1Database, options: { karma: boolean }): D1PreparedStatement[] {
  const everyone = `(SELECT user_id FROM profiles WHERE deleted_at IS NULL)`;
  return [
    ...(options.karma ? [db.prepare(`UPDATE profiles SET karma = ${TOTAL_KARMA} WHERE user_id IN ${everyone} AND karma IS NOT ${TOTAL_KARMA}`)] : []),
    trailFloors(db, everyone),
  ];
}

/** Recounts the karma of a member's group from what is stored: after an invitee came or went. */
export function settleKarma(db: D1Database, member: string, ...binds: unknown[]): D1PreparedStatement[] {
  const group = karmaGroupSql(member);
  return [db.prepare(`UPDATE profiles SET karma = ${TOTAL_KARMA} WHERE user_id IN ${group}`).bind(...binds), trailFloors(db, group, ...binds)];
}

/** The accounts whose karma votes on an item move: its author's group. */
export function karmaHoldersSql(type: TargetType, item: string): string {
  return karmaGroupSql(`(SELECT author_id FROM ${TABLE[type]} WHERE id = ${item})`);
}

/** The SQL condition that the item bound as `?{index}` takes votes at `now`. */
function openForVotes(type: TargetType, index: number, now: number): string {
  if (type === "post") {
    return `EXISTS (SELECT 1 FROM posts WHERE id = ?${index}
      AND deleted_at IS NULL AND removed_batch_id IS NULL)`;
  }
  // A comment takes votes while both it and its post are live; a fund
  // vote's nomination, until its nominations close, so the result stands.
  return `EXISTS (SELECT 1 FROM comments AS comment
    JOIN posts AS post ON post.id = comment.post_id
    WHERE comment.id = ?${index}
      AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
      AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL
      AND NOT (comment.parent_id IS NULL AND EXISTS (
        SELECT 1 FROM fund_votes WHERE fund_votes.post_id = comment.post_id AND fund_votes.closes_at <= ${Math.floor(now)})))`;
}

export type VoteResult =
  | { ok: true; score: number; vote: VoteValue }
  | { ok: false; reason: "not_found" | "closed" | "own" | "not_allowed" };

/**
 * Sets, changes, or clears one account's vote, then recomputes the item's
 * score and its author's karma from the votes table in the same batch, so
 * every contribution counts exactly once. The rules are part of the write:
 * no votes on one's own items, on removed or deleted ones, by agents, or
 * while banned.
 */
export async function castVote(
  db: D1Database,
  input: {
    voterId: string;
    type: TargetType;
    targetId: string;
    value: VoteValue;
    now: number;
  },
): Promise<VoteResult> {
  const { voterId, type, targetId, value, now } = input;
  const table = TABLE[type];

  // Nobody votes on what their own karma group wrote: their own items, or
  // their agent's.
  const allowed = `${openForVotes(type, 2, now)}
    AND ?1 NOT IN ${karmaHoldersSql(type, "?2")}
    AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = ?1 AND owner_id IS NOT NULL)
    AND ${participantCondition(1, now)}`;

  const change =
    value === 0
      ? db
          .prepare(
            `DELETE FROM votes
             WHERE voter_id = ?1 AND target_type = '${type}' AND target_id = ?2
               AND ${allowed}`,
          )
          .bind(voterId, targetId)
      : db
          .prepare(
            `INSERT INTO votes (voter_id, target_type, target_id, value, created_at)
             SELECT ?1, '${type}', ?2, ?3, ?4 WHERE ${allowed}
             ON CONFLICT (voter_id, target_type, target_id)
             DO UPDATE SET value = excluded.value`,
          )
          .bind(voterId, targetId, value, now);

  const [changed] = await db.batch([
    change,
    db.prepare(`UPDATE ${table} SET score = ${scoreSql(type, "?1")} WHERE id = ?1`).bind(targetId),
    ...recountKarma(db, karmaHoldersSql(type, "?1"), targetId),
  ]);

  const state = await db
    .prepare(
      `SELECT item.score, ?2 IN ${karmaHoldersSql(type, "?1")} AS own,
              ${openForVotes(type, 1, now)} AS open,
              (SELECT value FROM votes
               WHERE voter_id = ?2 AND target_type = '${type}' AND target_id = ?1) AS vote
       FROM ${table} AS item WHERE item.id = ?1`,
    )
    .bind(targetId, voterId)
    .first<{ score: number; own: number; open: number; vote: number | null }>();
  if (!state) return { ok: false, reason: "not_found" };

  // A write that changed nothing was refused, unless there was nothing to
  // clear in the first place.
  const current = (state.vote ?? 0) as VoteValue;
  if (changed.meta.changes === 0 && current !== value) {
    if (!state.open) return { ok: false, reason: "closed" };
    if (state.own) return { ok: false, reason: "own" };
    return { ok: false, reason: "not_allowed" };
  }
  return { ok: true, score: state.score, vote: current };
}

/** The account's votes on the given items, by item ID. */
export async function votesOn(
  db: D1Database,
  voterId: string,
  type: TargetType,
  ids: readonly string[],
): Promise<Record<string, 1 | -1>> {
  if (ids.length === 0) return {};
  // One JSON parameter rather than one per ID: D1 binds at most 100.
  const { results } = await db
    .prepare(
      `SELECT target_id, value FROM votes
       WHERE voter_id = ?1 AND target_type = '${type}'
         AND target_id IN (SELECT value FROM json_each(?2))`,
    )
    .bind(voterId, JSON.stringify([...new Set(ids)]))
    .all<{ target_id: string; value: 1 | -1 }>();
  return Object.fromEntries(results.map((row) => [row.target_id, row.value]));
}
