import { FRESH_START_ROOM, KARMA_FLOOR } from "../moderation";
import { participantCondition } from "./accounts.server";

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
 * (see trailingFloor). Runs after every karma recount, in the same batch.
 * Only accounts with a floor of their own are read, by a partial index.
 */
export function trailFloors(db: D1Database): D1PreparedStatement {
  return db.prepare(
    `UPDATE profiles SET karma_floor = CASE
       WHEN karma - ${FRESH_START_ROOM} >= ${KARMA_FLOOR} THEN NULL
       ELSE MAX(karma_floor, karma - ${FRESH_START_ROOM}) END
     WHERE karma_floor IS NOT NULL`,
  );
}

/** The accounts whose karma votes on an item move: its author's group. */
export function karmaHoldersSql(type: TargetType, item: string): string {
  return karmaGroupSql(`(SELECT author_id FROM ${TABLE[type]} WHERE id = ${item})`);
}

/** The SQL condition that the item bound as `?{index}` takes votes. */
function openForVotes(type: TargetType, index: number): string {
  if (type === "post") {
    return `EXISTS (SELECT 1 FROM posts WHERE id = ?${index}
      AND deleted_at IS NULL AND removed_batch_id IS NULL)`;
  }
  // A comment takes votes while both it and its post are live.
  return `EXISTS (SELECT 1 FROM comments AS comment
    JOIN posts AS post ON post.id = comment.post_id
    WHERE comment.id = ?${index}
      AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
      AND post.deleted_at IS NULL AND post.removed_batch_id IS NULL)`;
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
  const allowed = `${openForVotes(type, 2)}
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
    db
      .prepare(
        `UPDATE profiles SET karma = ${karmaSql("profiles.user_id")}
         WHERE user_id IN ${karmaHoldersSql(type, "?1")}`,
      )
      .bind(targetId),
    trailFloors(db),
  ]);

  const state = await db
    .prepare(
      `SELECT item.score, ?2 IN ${karmaHoldersSql(type, "?1")} AS own,
              ${openForVotes(type, 1)} AS open,
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
