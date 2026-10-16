import { URL_MAX } from "../fund";
import { newId } from "../ids";

/**
 * The fund: what fresh starts bring in goes to charity. Once a month an
 * admin gives what came in, less card fees, to the cause chosen for it, and
 * records the gift here with its receipt; `/fund` shows it all to everyone.
 * Amounts are US cents, before tax, less refunds.
 */

export interface FundCause {
  name: string;
  url: string;
  why: string | null;
  chosenAt: number;
}

export interface FundGift {
  id: string;
  givenOn: string;
  amountCents: number;
  recipient: string;
  recipientUrl: string;
  receiptUrl: string | null;
  note: string | null;
}

export interface FundSummary {
  /** What paid fresh starts brought in, before tax and card fees. */
  collectedCents: number;
  freshStarts: number;
  givenCents: number;
  /** The latest months with fresh starts, newest first: "2026-10". */
  months: Array<{ month: string; freshStarts: number; collectedCents: number }>;
  gifts: FundGift[];
  cause: FundCause | null;
  /** Members who chose to show their gift on their profile. */
  givers: string[];
}

export { CAUSE_NAME_MAX, CAUSE_WHY_MAX, GIFT_NOTE_MAX, URL_MAX } from "../fund";

/** A web address as typed, if it is an https one. */
export function httpsUrl(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > URL_MAX) return null;
  try {
    const url = new URL(trimmed);
    return url.protocol === "https:" && url.hostname.includes(".") ? url.toString() : null;
  } catch {
    return null;
  }
}

const COLLECTED = `SELECT COUNT(*) AS fresh_starts, COALESCE(SUM(amount_cents - refunded_cents), 0) AS collected
  FROM payments WHERE kind = 'fresh_start'`;

export async function fundSummary(db: D1Database): Promise<FundSummary> {
  const [totals, months, gifts, cause, givers] = await db.batch([
    db.prepare(`SELECT collected.*, (SELECT COALESCE(SUM(amount_cents), 0) FROM fund_gifts) AS given FROM (${COLLECTED}) AS collected`),
    db.prepare(
      `SELECT strftime('%Y-%m', paid_at, 'unixepoch') AS month, COUNT(*) AS fresh_starts,
              SUM(amount_cents - refunded_cents) AS collected
       FROM payments WHERE kind = 'fresh_start'
       GROUP BY month ORDER BY month DESC LIMIT 24`,
    ),
    db.prepare(
      `SELECT id, given_on, amount_cents, recipient, recipient_url, receipt_url, note FROM fund_gifts
       ORDER BY given_on DESC, recorded_at DESC LIMIT 200`,
    ),
    db.prepare(`SELECT name, url, why, chosen_at FROM fund_causes ORDER BY chosen_at DESC LIMIT 1`),
    db.prepare(
      `SELECT name.name FROM profiles AS profile
       JOIN usernames AS name ON name.user_id = profile.user_id AND name.is_current = 1
       WHERE profile.show_gift = 1 AND profile.deleted_at IS NULL
         AND EXISTS (SELECT 1 FROM payments WHERE payments.user_id = profile.user_id AND kind = 'fresh_start'
                       AND amount_cents > refunded_cents)
       ORDER BY name.name LIMIT 200`,
    ),
  ]);
  const total = totals!.results[0] as { fresh_starts: number; collected: number; given: number };
  const current = cause!.results[0] as { name: string; url: string; why: string | null; chosen_at: number } | undefined;
  return {
    collectedCents: total.collected,
    freshStarts: total.fresh_starts,
    givenCents: total.given,
    months: (months!.results as Array<{ month: string; fresh_starts: number; collected: number }>).map((row) => ({
      month: row.month,
      freshStarts: row.fresh_starts,
      collectedCents: row.collected,
    })),
    gifts: (
      gifts!.results as Array<{
        id: string;
        given_on: string;
        amount_cents: number;
        recipient: string;
        recipient_url: string;
        receipt_url: string | null;
        note: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      givenOn: row.given_on,
      amountCents: row.amount_cents,
      recipient: row.recipient,
      recipientUrl: row.recipient_url,
      receiptUrl: row.receipt_url,
      note: row.note,
    })),
    cause: current ? { name: current.name, url: current.url, why: current.why, chosenAt: current.chosen_at } : null,
    givers: (givers!.results as Array<{ name: string }>).map((row) => row.name),
  };
}

const STARTED_CACHE_MS = 10 * 60 * 1000;
let started: { value: boolean; at: number } | null = null;

/**
 * Whether any fresh start has been paid for, so the fund has something to
 * show: then the footer links to it. Kept for ten minutes per instance,
 * and for good once true.
 */
export async function fundStarted(db: D1Database, now = Date.now()): Promise<boolean> {
  if (started && (started.value || now - started.at < STARTED_CACHE_MS)) return started.value;
  const row = await db.prepare(`SELECT 1 AS any FROM payments WHERE kind = 'fresh_start' AND amount_cents > refunded_cents LIMIT 1`).first();
  started = { value: row !== null, at: now };
  return started.value;
}

/** Forgets this instance's answer, as tests need. */
export function forgetFundStarted(): void {
  started = null;
}

/** What a member's paid fresh starts gave, and whether their profile shows it. */
export async function giftStanding(db: D1Database, userId: string): Promise<{ gaveCents: number; shown: boolean }> {
  const row = await db
    .prepare(
      `SELECT profile.show_gift,
              (SELECT COALESCE(SUM(amount_cents - refunded_cents), 0) FROM payments
               WHERE user_id = profile.user_id AND kind = 'fresh_start') AS gave
       FROM profiles AS profile WHERE profile.user_id = ?1`,
    )
    .bind(userId)
    .first<{ show_gift: number; gave: number }>();
  return { gaveCents: row?.gave ?? 0, shown: row?.show_gift === 1 };
}

/** Shows or hides on the member's profile what their fresh starts gave. */
export async function setShowGift(db: D1Database, userId: string, shown: boolean): Promise<void> {
  await db.prepare(`UPDATE profiles SET show_gift = ?2 WHERE user_id = ?1`).bind(userId, shown ? 1 : 0).run();
}

/** Names the cause the fund gives to next, by an admin. */
export async function chooseCause(
  db: D1Database,
  input: { name: string; url: string; why: string | null; actorId: string; now: number },
): Promise<void> {
  await db
    .prepare(`INSERT INTO fund_causes (id, name, url, why, chosen_by, chosen_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)`)
    .bind(newId(), input.name, input.url, input.why, input.actorId, input.now)
    .run();
}

/** Records a gift the fund made, by an admin. */
export async function recordGift(
  db: D1Database,
  input: {
    givenOn: string;
    amountCents: number;
    recipient: string;
    recipientUrl: string;
    receiptUrl: string | null;
    note: string | null;
    actorId: string;
    now: number;
  },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO fund_gifts (id, given_on, amount_cents, currency, recipient, recipient_url, receipt_url, note, recorded_by, recorded_at)
       VALUES (?1, ?2, ?3, 'usd', ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(newId(), input.givenOn, input.amountCents, input.recipient, input.recipientUrl, input.receiptUrl, input.note, input.actorId, input.now)
    .run();
}

/** Removes a gift recorded by mistake, by an admin. */
export async function removeGift(db: D1Database, id: string): Promise<boolean> {
  const removed = await db.prepare(`DELETE FROM fund_gifts WHERE id = ?1`).bind(id).run();
  return removed.meta.changes > 0;
}
