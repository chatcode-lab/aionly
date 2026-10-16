import { FRESH_START_DAYS } from "../moderation";
import { settingSql } from "./setting-sql.server";
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

/** What became of a fresh start: applied, or declined for coming too soon after the last paid one. */
export type FreshStartOutcome = "applied" | "declined" | "none";

/**
 * Applies a fresh start once, however often it is reported: Stripe's return
 * page and its webhook both call this with the checkout's ID. The floor of
 * the member and their agent goes to the room below their karma, and never
 * up. A paid one within 30 days of the last paid one applied is declined
 * instead, in the same batch, however the two payments came about, so it
 * can be refunded; an admin's grant is never declined.
 */
export async function applyFreshStart(
  db: D1Database,
  input: { id: string; userId: string; source: "stripe" | "admin"; now: number },
): Promise<FreshStartOutcome> {
  const floor = `MIN(COALESCE(karma_floor, ${settingSql("karma_floor")}), karma - ${settingSql("fresh_start_room")})`;
  // ?1 the fresh start, ?2 the member, ?3 now.
  const tooSoon = `(EXISTS (SELECT 1 FROM fresh_starts AS this WHERE this.id = ?1 AND this.source = 'stripe')
    AND EXISTS (SELECT 1 FROM fresh_starts AS other
      WHERE other.user_id = ?2 AND other.source = 'stripe' AND other.id <> ?1
        AND other.applied_at > ?3 - ${FRESH_START_DAYS * DAY}))`;
  const waiting = `EXISTS (SELECT 1 FROM fresh_starts WHERE id = ?1 AND user_id = ?2 AND applied_at IS NULL AND declined_at IS NULL)`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO fresh_starts (id, user_id, source, created_at) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT (id) DO NOTHING`,
      )
      .bind(input.id, input.userId, input.source, input.now),
    db
      .prepare(`UPDATE fresh_starts SET declined_at = ?3 WHERE id = ?1 AND user_id = ?2 AND ${waiting} AND ${tooSoon}`)
      .bind(input.id, input.userId, input.now),
    // Only while this fresh start is neither applied nor declined, so a repeat changes nothing.
    db
      .prepare(`UPDATE profiles SET karma_floor = ${floor} WHERE user_id IN ${karmaGroupSql("?2")} AND ${waiting}`)
      .bind(input.id, input.userId),
    db
      .prepare(
        `UPDATE fresh_starts SET applied_at = ?3,
           karma = (SELECT karma FROM profiles WHERE user_id = ?2),
           floor = (SELECT karma_floor FROM profiles WHERE user_id = ?2)
         WHERE id = ?1 AND user_id = ?2 AND applied_at IS NULL AND declined_at IS NULL`,
      )
      .bind(input.id, input.userId, input.now),
    // Settles the new floor at once, as any recount would.
    trailFloors(db, karmaGroupSql("?1"), input.userId),
  ]);
  const row = await db
    .prepare(`SELECT applied_at, declined_at FROM fresh_starts WHERE id = ?1 AND user_id = ?2`)
    .bind(input.id, input.userId)
    .first<{ applied_at: number | null; declined_at: number | null }>();
  return row?.applied_at != null ? "applied" : row?.declined_at != null ? "declined" : "none";
}
