import { newId } from "../ids";
import { type PartnerStep, SHARED_JOIN_CODE } from "../partners";
import type { PublicAuthor } from "../public-types";
import { AUTHOR_COLUMNS, AUTHOR_JOINS, toPublicAuthor } from "./rows.server";
import { settleKarma } from "./votes.server";

/**
 * Partner links (see `../partners.ts`): made by admins for a partner's
 * account, each keeping the share it was made with, in steps of months
 * (`partner_link_steps`), and the free invitations of those who join. A
 * link works while it is not revoked, not past its end, below its limit,
 * and its partner's account is live and not banned. A member who joins
 * through one is invited by the partner, as by an invitation, and their
 * plan payments count toward the partner's share by the step they fall in.
 */

const banned = (alias: string, now: string) =>
  `(${alias}.banned_at IS NOT NULL AND (${alias}.banned_until IS NULL OR ${alias}.banned_until > ${now}))`;

/** Whether the link `link` (an alias of partner_links) takes a sign-up at `now` (SQL). */
function openSql(link: string, now: string): string {
  return `(${link}.revoked_at IS NULL AND (${link}.ends_at IS NULL OR ${link}.ends_at > ${now})
    AND (${link}.max_uses IS NULL OR (SELECT COUNT(*) FROM partner_joins WHERE partner_joins.code = ${link}.code) < ${link}.max_uses)
    AND EXISTS (SELECT 1 FROM profiles AS partner WHERE partner.user_id = ${link}.partner_id
                AND partner.deleted_at IS NULL AND partner.owner_id IS NULL AND NOT ${banned("partner", now)}))`;
}

/** The link `link`'s steps in order, as JSON: [{percent, months}], months null for good (SQL). */
const STEPS_SQL = `(SELECT json_group_array(json_object('percent', share_percent, 'months', until_month - from_month))
  FROM (SELECT * FROM partner_link_steps WHERE code = link.code ORDER BY from_month))`;

const SHARED_CACHE_MS = 60 * 1000;
let shared: { code: string | null; at: number } | null = null;

/**
 * The partner link offered to anyone signing up (`SHARED_JOIN_CODE`), while
 * it is open, or null. Kept a minute per instance, since every page a
 * visitor opens asks.
 */
export async function sharedJoinCode(db: D1Database, now = Date.now()): Promise<string | null> {
  if (shared && now - shared.at < SHARED_CACHE_MS) return shared.code;
  const row = await db
    .prepare(`SELECT ${openSql("link", "?2")} AS open FROM partner_links AS link WHERE link.code = ?1`)
    .bind(SHARED_JOIN_CODE, Math.floor(now / 1000))
    .first<{ open: number }>();
  shared = { code: row?.open ? SHARED_JOIN_CODE : null, at: now };
  return shared.code;
}

/** Forgets this instance's answer, as tests need. */
export function forgetSharedJoin(): void {
  shared = null;
}

export type PartnerLinkState = "open" | "full" | "ended" | "revoked" | "paused";

/** A partner link as its page shows it, or null when there is none. */
export async function partnerLinkByCode(
  db: D1Database,
  code: string,
  now: number,
): Promise<{ state: PartnerLinkState; partner: PublicAuthor; steps: PartnerStep[] } | null> {
  const row = await db
    .prepare(
      `SELECT link.revoked_at, link.ends_at, link.max_uses, ${STEPS_SQL} AS steps,
              (SELECT COUNT(*) FROM partner_joins WHERE partner_joins.code = link.code) AS joined,
              ${openSql("link", "?2")} AS open, ${AUTHOR_COLUMNS}
       FROM (SELECT *, partner_id AS author_id FROM partner_links WHERE code = ?1) AS link
       ${AUTHOR_JOINS("link")}`,
    )
    .bind(code, now)
    .first<Parameters<typeof toPublicAuthor>[0] & {
      revoked_at: number | null;
      ends_at: number | null;
      max_uses: number | null;
      steps: string;
      joined: number;
      open: number;
    }>();
  if (!row) return null;
  const state: PartnerLinkState = row.open
    ? "open"
    : row.revoked_at !== null
      ? "revoked"
      : row.ends_at !== null && row.ends_at <= now
        ? "ended"
        : row.max_uses !== null && row.joined >= row.max_uses
          ? "full"
          : "paused";
  return { state, partner: toPublicAuthor(row), steps: JSON.parse(row.steps) as PartnerStep[] };
}

/**
 * Claims a partner link for a sign-up, before its account exists, for the
 * account ID the sign-up will make, inside the write: only while the link
 * takes sign-ups, so its limit holds however many sign up at once.
 */
export async function claimPartnerJoin(db: D1Database, input: { code: string; userId: string; now: number }): Promise<boolean> {
  const claimed = await db
    .prepare(
      `INSERT INTO partner_joins (user_id, code, joined_at)
       SELECT ?2, link.code, ?3 FROM partner_links AS link WHERE link.code = ?1 AND ${openSql("link", "?3")}
       ON CONFLICT (user_id) DO NOTHING`,
    )
    .bind(input.code, input.userId, input.now)
    .run();
  return claimed.meta.changes > 0;
}

/**
 * Gives the new account the partner it joined through as its inviter,
 * unless an invitation already named one, a level below the partner in the
 * invitation tree, with the free invitations the link gives, and settles
 * the partner's karma, as attachInvite does. Safe to repeat.
 */
export async function attachPartner(db: D1Database, input: { userId: string }): Promise<void> {
  const link = (column: string) => `SELECT link.${column} FROM partner_joins AS joined JOIN partner_links AS link ON link.code = joined.code
    WHERE joined.user_id = ?1 AND link.partner_id <> ?1`;
  await db.batch([
    db
      .prepare(
        `UPDATE profiles SET invited_by = (${link("partner_id")}), free_invites = (${link("free_invites")}),
           invite_depth = COALESCE((SELECT partner.invite_depth + 1 FROM profiles AS partner WHERE partner.user_id = (${link("partner_id")})), 1)
         WHERE user_id = ?1 AND invited_by IS NULL AND EXISTS (${link("partner_id")})`,
      )
      .bind(input.userId),
    ...settleKarma(db, `(SELECT invited_by FROM profiles WHERE user_id = ?1)`, input.userId),
  ]);
}

/** How long a claim waits for its sign-up to finish before the sweep looks at it. */
const CLAIM_GRACE_SECONDS = 600;

/**
 * Settles partner claims whose sign-up did not finish: one whose account
 * was made gets its partner; one whose account never came is dropped, so
 * it no longer counts toward the link's limit. A finished join stays for
 * good, its account deleted or not: the partner's share of what it paid
 * hangs on it, and the account it made used its place.
 */
export async function sweepPartnerJoins(db: D1Database, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT joined.user_id FROM partner_joins AS joined JOIN profiles AS profile ON profile.user_id = joined.user_id
       WHERE joined.joined_at < ?1 AND profile.invited_by IS NULL LIMIT 100`,
    )
    .bind(now - CLAIM_GRACE_SECONDS)
    .all<{ user_id: string }>();
  for (const { user_id: userId } of results) await attachPartner(db, { userId });
  const dropped = await db
    .prepare(
      `DELETE FROM partner_joins WHERE joined_at < ?1
         AND NOT EXISTS (SELECT 1 FROM "user" WHERE "id" = partner_joins.user_id)
         AND NOT EXISTS (SELECT 1 FROM profiles WHERE user_id = partner_joins.user_id)`,
    )
    .bind(now - CLAIM_GRACE_SECONDS)
    .run();
  return results.length + dropped.meta.changes;
}

/**
 * What the members who joined through the step `step`'s link paid for the
 * plan within its months of their joining, before tax, less refunds (SQL).
 */
const STEP_REVENUE = `(SELECT COALESCE(SUM(payment.amount_cents - payment.refunded_cents), 0)
  FROM partner_joins AS joined JOIN payments AS payment ON payment.user_id = joined.user_id AND payment.kind = 'plan'
  WHERE joined.code = step.code
    AND payment.paid_at >= unixepoch(joined.joined_at, 'unixepoch', '+' || step.from_month || ' months')
    AND (step.until_month IS NULL
      OR payment.paid_at < unixepoch(joined.joined_at, 'unixepoch', '+' || step.until_month || ' months')))`;

/** What the link `link`'s steps brought in, and the partner's share of it, by step (SQL). */
const REVENUE = `(SELECT COALESCE(SUM(${STEP_REVENUE}), 0) FROM partner_link_steps AS step WHERE step.code = link.code)`;
const EARNED = `(SELECT COALESCE(SUM(${STEP_REVENUE} * step.share_percent / 100), 0) FROM partner_link_steps AS step WHERE step.code = link.code)`;


export interface PartnerLinkStats {
  code: string;
  partner: string;
  partnerId: string;
  /** The share by months after joining. */
  steps: PartnerStep[];
  /** Free invitations each member who joins gets, or null for their level's. */
  freeInvites: number | null;
  maxUses: number | null;
  endsAt: number | null;
  revokedAt: number | null;
  note: string | null;
  createdAt: number;
  /** Not revoked, and not past its end. */
  live: boolean;
  /** Accounts made through it. */
  joined: number;
  /** Of those, how many have the Fan plan now. */
  fans: number;
  /** What they paid for the plan in their shared months, before VAT, less refunds. */
  revenueCents: number;
  /** The partner's share of it. */
  earnedCents: number;
}

export interface PartnerStanding {
  links: PartnerLinkStats[];
  earnedCents: number;
  paidCents: number;
  payouts: Array<{ id: string; paidOn: string; amountCents: number; note: string | null }>;
}

/**
 * Each link with what it brought, for an admin (every link) or a partner
 * (their own), and the partner's share earned and paid out. A payment
 * counts at the share of the step its time since the member joined falls in.
 */
export async function partnerLinks(db: D1Database, input: { partnerId?: string; now: number }): Promise<PartnerLinkStats[]> {
  const { results } = await db
    .prepare(
      `SELECT link.code, link.partner_id, name.name AS partner, ${STEPS_SQL} AS steps, link.free_invites, link.max_uses,
              link.ends_at, link.revoked_at, link.note, link.created_at,
              (SELECT COUNT(*) FROM partner_joins AS joined JOIN profiles AS member ON member.user_id = joined.user_id
                WHERE joined.code = link.code AND member.deleted_at IS NULL) AS joined,
              (SELECT COUNT(*) FROM partner_joins AS joined JOIN profiles AS member ON member.user_id = joined.user_id
                WHERE joined.code = link.code AND member.deleted_at IS NULL AND COALESCE(member.plan_until, 0) > ?2) AS fans,
              ${REVENUE} AS revenue, ${EARNED} AS earned
       FROM partner_links AS link
       JOIN usernames AS name ON name.user_id = link.partner_id AND name.is_current = 1
       WHERE ?1 IS NULL OR link.partner_id = ?1
       ORDER BY link.created_at DESC
       LIMIT 200`,
    )
    .bind(input.partnerId ?? null, input.now)
    .all<{
      code: string;
      partner_id: string;
      partner: string;
      steps: string;
      free_invites: number | null;
      max_uses: number | null;
      ends_at: number | null;
      revoked_at: number | null;
      note: string | null;
      created_at: number;
      joined: number;
      fans: number;
      revenue: number;
      earned: number;
    }>();
  return results.map((row) => ({
    code: row.code,
    partner: row.partner,
    partnerId: row.partner_id,
    steps: JSON.parse(row.steps) as PartnerStep[],
    freeInvites: row.free_invites,
    maxUses: row.max_uses,
    endsAt: row.ends_at,
    revokedAt: row.revoked_at,
    note: row.note,
    createdAt: row.created_at,
    live: row.revoked_at === null && (row.ends_at === null || row.ends_at > input.now),
    joined: row.joined,
    fans: row.fans,
    revenueCents: row.revenue,
    earnedCents: row.earned,
  }));
}

/**
 * Each partner's share earned over all their links and paid over all their
 * payouts, never limited the way the lists are (SQL rows: partner_id,
 * earned, paid). With `partnerId`, only theirs.
 */
async function ledger(db: D1Database, partnerId: string | null): Promise<Map<string, { earned: number; paid: number }>> {
  const [earned, paid] = await db.batch([
    db
      .prepare(
        `SELECT link.partner_id, SUM(${EARNED}) AS earned
         FROM partner_links AS link WHERE ?1 IS NULL OR link.partner_id = ?1 GROUP BY link.partner_id`,
      )
      .bind(partnerId),
    db
      .prepare(`SELECT partner_id, SUM(amount_cents) AS paid FROM partner_payouts WHERE ?1 IS NULL OR partner_id = ?1 GROUP BY partner_id`)
      .bind(partnerId),
  ]);
  const totals = new Map<string, { earned: number; paid: number }>();
  for (const row of earned!.results as Array<{ partner_id: string; earned: number }>) totals.set(row.partner_id, { earned: row.earned, paid: 0 });
  for (const row of paid!.results as Array<{ partner_id: string; paid: number }>) {
    totals.set(row.partner_id, { earned: totals.get(row.partner_id)?.earned ?? 0, paid: row.paid });
  }
  return totals;
}

/** A partner's links, their share earned, and what was paid out to them. */
export async function partnerStanding(db: D1Database, partnerId: string, now: number): Promise<PartnerStanding> {
  const links = await partnerLinks(db, { partnerId, now });
  const { results } = await db
    .prepare(`SELECT id, paid_on, amount_cents, note FROM partner_payouts WHERE partner_id = ?1 ORDER BY paid_on DESC LIMIT 200`)
    .bind(partnerId)
    .all<{ id: string; paid_on: string; amount_cents: number; note: string | null }>();
  const totals = (await ledger(db, partnerId)).get(partnerId) ?? { earned: 0, paid: 0 };
  return {
    links,
    earnedCents: totals.earned,
    paidCents: totals.paid,
    payouts: results.map((row) => ({ id: row.id, paidOn: row.paid_on, amountCents: row.amount_cents, note: row.note })),
  };
}

export type PartnerLinkProblem = "taken" | "no_partner";

/**
 * Makes a partner link for a member's account, by an admin, with its
 * share's steps in one batch. Its terms are fixed with it. The steps are
 * checked by the caller (see partnerStepsProblem). Answers the problem, or
 * null.
 */
export async function createPartnerLink(
  db: D1Database,
  input: {
    code: string;
    partner: string;
    steps: PartnerStep[];
    /** Free invitations each member who joins gets, or null for their level's. */
    freeInvites: number | null;
    maxUses: number | null;
    endsAt: number | null;
    note: string | null;
    actorId: string;
    now: number;
  },
): Promise<PartnerLinkProblem | null> {
  const partner = await db
    .prepare(
      `SELECT profile.user_id FROM usernames AS name JOIN profiles AS profile ON profile.user_id = name.user_id
       WHERE name.name = ?1 AND name.is_current = 1 AND profile.deleted_at IS NULL AND profile.owner_id IS NULL`,
    )
    .bind(input.partner.trim().replace(/^@/, "").toLowerCase())
    .first<{ user_id: string }>();
  if (!partner) return "no_partner";
  let from = 0;
  const steps = input.steps.map((step) => {
    const row = { from, until: step.months === null ? null : from + step.months, percent: step.percent };
    from = row.until ?? from;
    return row;
  });
  try {
    await db.batch([
      db
        .prepare(
          `INSERT INTO partner_links (code, partner_id, free_invites, max_uses, ends_at, note, created_by, created_at)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
        )
        .bind(input.code, partner.user_id, input.freeInvites, input.maxUses, input.endsAt, input.note, input.actorId, input.now),
      ...steps.map((step) =>
        db
          .prepare(`INSERT INTO partner_link_steps (code, from_month, until_month, share_percent) VALUES (?1, ?2, ?3, ?4)`)
          .bind(input.code, step.from, step.until, step.percent),
      ),
    ]);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return "taken";
    throw error;
  }
  return null;
}

/** Stops a link taking sign-ups, by an admin. Those who joined keep counting. */
export async function revokePartnerLink(db: D1Database, input: { code: string; now: number }): Promise<boolean> {
  const revoked = await db
    .prepare(`UPDATE partner_links SET revoked_at = ?2 WHERE code = ?1 AND revoked_at IS NULL`)
    .bind(input.code, input.now)
    .run();
  return revoked.meta.changes > 0;
}

/** Records a payout of a partner's share, by an admin. */
export async function recordPayout(
  db: D1Database,
  input: { partnerId: string; amountCents: number; paidOn: string; note: string | null; actorId: string; now: number },
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO partner_payouts (id, partner_id, amount_cents, currency, paid_on, note, recorded_by, recorded_at)
       VALUES (?1, ?2, ?3, 'usd', ?4, ?5, ?6, ?7)`,
    )
    .bind(newId(), input.partnerId, input.amountCents, input.paidOn, input.note, input.actorId, input.now)
    .run();
}

/** Every partner's share earned and paid out, over the whole ledger, for admins. */
export async function partnersOwed(
  db: D1Database,
  _now: number,
): Promise<Array<{ partnerId: string; partner: string; earnedCents: number; paidCents: number }>> {
  const totals = await ledger(db, null);
  if (totals.size === 0) return [];
  const { results } = await db
    .prepare(`SELECT user_id, name FROM usernames WHERE is_current = 1 AND user_id IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify([...totals.keys()]))
    .all<{ user_id: string; name: string }>();
  const names = new Map(results.map((row) => [row.user_id, row.name]));
  return [...totals].map(([partnerId, total]) => ({
    partnerId,
    partner: names.get(partnerId) ?? "[deleted]",
    earnedCents: total.earned,
    paidCents: total.paid,
  }));
}

/** Who joined through each link, newest first, a few thousand at most, for admins: [code, members] pairs. */
export async function joinedThrough(
  db: D1Database,
  codes: string[],
): Promise<Array<[string, Array<{ username: string; joinedAt: number; fan: boolean }>]>> {
  if (codes.length === 0) return [];
  const { results } = await db
    .prepare(
      `SELECT joined.code, name.name AS username, joined.joined_at, COALESCE(member.plan_until, 0) > ?2 AS fan
       FROM partner_joins AS joined
       JOIN profiles AS member ON member.user_id = joined.user_id AND member.deleted_at IS NULL
       JOIN usernames AS name ON name.user_id = joined.user_id AND name.is_current = 1
       WHERE joined.code IN (SELECT value FROM json_each(?1))
       ORDER BY joined.joined_at DESC
       LIMIT 2000`,
    )
    .bind(JSON.stringify(codes), Math.floor(Date.now() / 1000))
    .all<{ code: string; username: string; joined_at: number; fan: number }>();
  // A Map, since any code is a valid name, `constructor` included.
  const byCode = new Map<string, Array<{ username: string; joinedAt: number; fan: boolean }>>();
  for (const row of results) {
    const members = byCode.get(row.code) ?? [];
    members.push({ username: row.username, joinedAt: row.joined_at, fan: row.fan === 1 });
    byCode.set(row.code, members);
  }
  return [...byCode];
}
