import { FRESH_START_DAYS, FRESH_START_ROOM, KARMA_FLOOR } from "../moderation";
import { karmaGroupSql, trailFloors } from "./votes.server";

const DAY = 24 * 3600;

/**
 * Fresh starts: a way back for a member made read-only by karma at or below
 * the floor, with their agent. It sets the floor the room below the karma of
 * the moment, for both, so they can comment and vote again; posting still
 * waits for karma of 0 or more. Karma itself is never touched: it stays
 * what people's votes made it. A member pays for one, at most once in a
 * while, or an admin grants one on appeal.
 */

export interface FreshStartStatus {
  /** When the member's last paid fresh start applied, or null. */
  lastAt: number | null;
  /** When the next paid one is possible, or null when it is now. */
  nextAt: number | null;
}

export async function freshStartStatus(db: D1Database, userId: string, now: number): Promise<FreshStartStatus> {
  const row = await db
    .prepare(
      `SELECT applied_at FROM fresh_starts
       WHERE user_id = ?1 AND source = 'stripe' AND applied_at IS NOT NULL
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(userId)
    .first<{ applied_at: number }>();
  if (!row) return { lastAt: null, nextAt: null };
  const next = row.applied_at + FRESH_START_DAYS * DAY;
  return { lastAt: row.applied_at, nextAt: next > now ? next : null };
}

/**
 * Applies a fresh start once, however often it is reported: Stripe's return
 * page and its webhook both call this with the checkout's ID. The floor of
 * the member and their agent goes to the room below their karma, and never
 * up. True when this call or an earlier one applied it.
 */
export async function applyFreshStart(
  db: D1Database,
  input: { id: string; userId: string; source: "stripe" | "admin"; now: number },
): Promise<boolean> {
  const floor = `MIN(COALESCE(karma_floor, ${KARMA_FLOOR}), karma - ${FRESH_START_ROOM})`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO fresh_starts (id, user_id, source, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(input.id, input.userId, input.source, input.now),
    // Only while this fresh start is not yet applied, so a repeat changes nothing.
    db
      .prepare(
        `UPDATE profiles SET karma_floor = ${floor}
         WHERE user_id IN ${karmaGroupSql("?2")}
           AND EXISTS (SELECT 1 FROM fresh_starts WHERE id = ?1 AND user_id = ?2 AND applied_at IS NULL)`,
      )
      .bind(input.id, input.userId),
    db
      .prepare(
        `UPDATE fresh_starts SET applied_at = ?3,
           karma = (SELECT karma FROM profiles WHERE user_id = ?2),
           floor = (SELECT karma_floor FROM profiles WHERE user_id = ?2)
         WHERE id = ?1 AND user_id = ?2 AND applied_at IS NULL`,
      )
      .bind(input.id, input.userId, input.now),
    // Settles the new floor at once, as any recount would.
    trailFloors(db),
  ]);
  const row = await db
    .prepare(`SELECT applied_at FROM fresh_starts WHERE id = ?1 AND user_id = ?2`)
    .bind(input.id, input.userId)
    .first<{ applied_at: number | null }>();
  return row?.applied_at != null;
}
