import { URL_MAX } from "../fund";
import { newId } from "../ids";
import { postPath } from "../slug";
import { plainText } from "../text/markdown";

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
  /** The post members chose it in, if they did. */
  vote: { path: string; title: string } | null;
}

/** Members choosing the next cause in a post: nominations are its top-level comments. */
export interface FundVote {
  id: string;
  postId: string;
  /** Its post, while live; a removed or deleted post shows nowhere. */
  post: { path: string; title: string } | null;
  closesAt: number;
  /** Nominations and their votes have closed; an admin names the result. */
  closed: boolean;
}

/** A post as a fund page may show it: only while it is live. */
const LIVE_POST = `post.deleted_at IS NULL AND post.removed_batch_id IS NULL`;

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
  /** The cause chosen for the next gift, while no vote is open. */
  cause: FundCause | null;
  /** A vote still open, if any. */
  vote: FundVote | null;
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

export async function fundSummary(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<FundSummary> {
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
    db.prepare(
      `SELECT cause.name, cause.url, cause.why, cause.chosen_at, post.id AS post_id, post.title AS post_title
       FROM fund_causes AS cause
       LEFT JOIN fund_votes AS vote ON vote.id = cause.vote_id
       LEFT JOIN posts AS post ON post.id = vote.post_id AND ${LIVE_POST}
       ORDER BY cause.chosen_at DESC LIMIT 1`,
    ),
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
  const current = cause!.results[0] as
    | { name: string; url: string; why: string | null; chosen_at: number; post_id: string | null; post_title: string | null }
    | undefined;
  const vote = await openVote(db, now);
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
    cause:
      current && !vote
        ? {
            name: current.name,
            url: current.url,
            why: current.why,
            chosenAt: current.chosen_at,
            vote: current.post_id && current.post_title ? { path: postPath({ id: current.post_id, title: current.post_title }), title: current.post_title } : null,
          }
        : null,
    vote,
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
  // The cause members chose, when a vote is open: it closes with it.
  const vote = await openVote(db);
  await db.batch([
    db
      .prepare(`INSERT INTO fund_causes (id, name, url, why, chosen_by, chosen_at, vote_id) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`)
      .bind(newId(), input.name, input.url, input.why, input.actorId, input.now, vote?.id ?? null),
    db.prepare(`UPDATE fund_votes SET decided_at = ?2 WHERE id = ?1 AND decided_at IS NULL`).bind(vote?.id ?? "", input.now),
  ]);
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

/** The vote still open, with its post while live, if any. */
export async function openVote(db: D1Database, now = Math.floor(Date.now() / 1000)): Promise<FundVote | null> {
  const row = await db
    .prepare(
      `SELECT vote.id, vote.post_id, vote.closes_at, CASE WHEN ${LIVE_POST} THEN post.title END AS title
       FROM fund_votes AS vote JOIN posts AS post ON post.id = vote.post_id
       WHERE vote.decided_at IS NULL ORDER BY vote.opened_at DESC LIMIT 1`,
    )
    .first<{ id: string; post_id: string; closes_at: number; title: string | null }>();
  if (!row) return null;
  return {
    id: row.id,
    postId: row.post_id,
    post: row.title === null ? null : { path: postPath({ id: row.post_id, title: row.title }), title: row.title },
    closesAt: row.closes_at,
    closed: row.closes_at <= now,
  };
}

/** Closes the open vote without naming a cause, by an admin: when its post is gone, or it is to start again. */
export async function closeVote(db: D1Database, now: number): Promise<boolean> {
  const closed = await db.prepare(`UPDATE fund_votes SET decided_at = ?1 WHERE decided_at IS NULL`).bind(now).run();
  return closed.meta.changes > 0;
}

/** A post's ID from its address or the ID itself, as an admin pastes it. */
export function postIdOf(typed: string): string | null {
  const match = /(?:^|\/p\/)([a-z0-9]{7})(?:[/?#]|$)/.exec(typed.trim());
  return match ? match[1]! : null;
}

export type OpenVoteResult = { ok: true } | { ok: false; reason: "no_post" | "open_already" };

/** Opens a vote on the next cause in a live post, by an admin; one at a time. */
export async function startVote(
  db: D1Database,
  input: { postId: string; closesAt: number; actorId: string; now: number },
): Promise<OpenVoteResult> {
  if (await openVote(db)) return { ok: false, reason: "open_already" };
  const made = await db
    .prepare(
      `INSERT INTO fund_votes (id, post_id, closes_at, opened_by, opened_at)
       SELECT ?1, ?2, ?3, ?4, ?5 WHERE EXISTS (SELECT 1 FROM posts WHERE id = ?2 AND deleted_at IS NULL AND removed_batch_id IS NULL)
         AND NOT EXISTS (SELECT 1 FROM fund_votes WHERE decided_at IS NULL)`,
    )
    .bind(newId(), input.postId, input.closesAt, input.actorId, input.now)
    .run();
  return made.meta.changes > 0 ? { ok: true } : { ok: false, reason: "no_post" };
}

/** The vote's nominations: its post's live top-level comments, the most voted first. */
export async function nominations(
  db: D1Database,
  postId: string,
): Promise<Array<{ id: string; author: string; score: number; text: string }>> {
  const { results } = await db
    .prepare(
      `SELECT comment.id, comment.body, comment.score, name.name AS author FROM comments AS comment
       JOIN usernames AS name ON name.user_id = comment.author_id AND name.is_current = 1
       WHERE comment.post_id = ?1 AND comment.parent_id IS NULL AND comment.deleted_at IS NULL AND comment.removed_batch_id IS NULL
       ORDER BY comment.score DESC, comment.created_at LIMIT 10`,
    )
    .bind(postId)
    .all<{ id: string; body: string; score: number; author: string }>();
  return results.map((row) => ({ id: row.id, author: row.author, score: row.score, text: plainText(row.body).slice(0, 280) }));
}
