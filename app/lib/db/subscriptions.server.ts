import { intervalOf, periodEnd, scheduledSwitch, type StripeSubscription } from "../billing/stripe";

/**
 * Days the plan stays in force past the end of the period paid for, so a
 * renewal that Stripe confirms late, or retries, interrupts nothing.
 */
export const PLAN_GRACE_SECONDS = 3 * 24 * 3600;

/** Stripe statuses under which the plan is in force. */
const IN_FORCE = new Set(["active", "trialing", "past_due"]);

/** An account's plan as Settings and the Fan plan page show it. */
export interface PlanStatus {
  customerId: string | null;
  status: string | null;
  interval: "month" | "year" | null;
  /** The lookup key of the price billed, a new member's or the plan's own. */
  priceKey: string | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
  /** A switch asked for, to this price's key, made at `nextAt`, the period's end. */
  nextPriceKey: string | null;
  nextAt: number | null;
}

export async function planStatus(db: D1Database, userId: string): Promise<PlanStatus> {
  const row = await db
    .prepare(
      `SELECT customer_id, status, interval, price_key, period_end, cancel_at_period_end, next_price_key, next_price_at
       FROM subscriptions WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<{
      customer_id: string;
      status: string | null;
      interval: "month" | "year" | null;
      price_key: string | null;
      period_end: number | null;
      cancel_at_period_end: number;
      next_price_key: string | null;
      next_price_at: number | null;
    }>();
  return {
    customerId: row?.customer_id ?? null,
    status: row?.status ?? null,
    interval: row?.interval ?? null,
    priceKey: row?.price_key ?? null,
    periodEnd: row?.period_end ?? null,
    cancelAtPeriodEnd: row?.cancel_at_period_end === 1,
    nextPriceKey: row?.next_price_key ?? null,
    nextAt: row?.next_price_at ?? null,
  };
}

/**
 * The time to stamp a subscription read fresh from Stripe now: now, but
 * never before the last event applied, so a clock a little behind
 * Stripe's cannot make the freshest word read as stale.
 */
export async function freshEventAt(db: D1Database, userId: string, now: number): Promise<number> {
  const row = await db.prepare(`SELECT event_at FROM subscriptions WHERE user_id = ?1`).bind(userId).first<{ event_at: number | null }>();
  return Math.max(now, row?.event_at ?? 0);
}

/** Records an account's Stripe customer, made before its first checkout. */
export async function rememberCustomer(db: D1Database, input: { userId: string; customerId: string; now: number }): Promise<void> {
  await db
    .prepare(
      `INSERT INTO subscriptions (user_id, customer_id, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT (user_id) DO NOTHING`,
    )
    .bind(input.userId, input.customerId, input.now)
    .run();
}

/**
 * When the plan this subscription pays for ends: a little past its period
 * while Stripe counts it as paid, or now once it is cancelled or unpaid.
 */
export function planUntilFor(subscription: StripeSubscription, now: number): number {
  const end = periodEnd(subscription);
  return IN_FORCE.has(subscription.status) && end !== null ? end + PLAN_GRACE_SECONDS : now;
}

/**
 * Takes Stripe's word for a subscription: its status, period, and whether
 * it ends at the period's close, and with them how long the plan is in
 * force. The account is the one that owns the Stripe customer, or else the
 * one named in the subscription's metadata. A state older than the one
 * already applied is ignored, since Stripe does not promise to deliver
 * events in order. Returns false when no account matches.
 */
export async function applySubscription(
  db: D1Database,
  subscription: StripeSubscription,
  input: { eventAt: number; now: number },
): Promise<boolean> {
  const owner = await db
    .prepare(
      `SELECT user_id FROM subscriptions WHERE customer_id = ?1
       UNION ALL
       SELECT user_id FROM profiles WHERE user_id = ?2 AND owner_id IS NULL
       LIMIT 1`,
    )
    .bind(subscription.customer, subscription.metadata?.user_id ?? null)
    .first<{ user_id: string }>();
  if (!owner) return false;

  const until = planUntilFor(subscription, input.now);
  // The switch its schedule holds; unknown when the schedule was not read, and kept then.
  const next = scheduledSwitch(subscription);
  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, interval, period_end,
           cancel_at_period_end, event_at, updated_at, price_key, next_price_key, next_price_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
         ON CONFLICT (user_id) DO UPDATE SET
           customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
           status = excluded.status, interval = excluded.interval, period_end = excluded.period_end,
           price_key = excluded.price_key,
           next_price_key = CASE WHEN ?13 THEN excluded.next_price_key ELSE subscriptions.next_price_key END,
           next_price_at = CASE WHEN ?13 THEN excluded.next_price_at ELSE subscriptions.next_price_at END,
           cancel_at_period_end = excluded.cancel_at_period_end, event_at = excluded.event_at,
           updated_at = excluded.updated_at
         WHERE (subscriptions.event_at IS NULL OR subscriptions.event_at <= excluded.event_at)
           -- A late word about an old subscription never displaces one in force.
           AND (subscriptions.subscription_id IS NULL
             OR subscriptions.subscription_id = excluded.subscription_id
             OR subscriptions.status NOT IN ('active', 'trialing', 'past_due'))
           -- Stripe never revives an ended subscription, so an earlier read
           -- of it, applied late in the same second, cannot either.
           AND NOT (subscriptions.subscription_id IS excluded.subscription_id
             AND COALESCE(subscriptions.status, '') IN ('canceled', 'incomplete_expired')
             AND excluded.status NOT IN ('canceled', 'incomplete_expired'))`,
      )
      .bind(
        owner.user_id,
        subscription.customer,
        subscription.id,
        subscription.status,
        intervalOf(subscription),
        periodEnd(subscription),
        subscription.cancel_at_period_end ? 1 : 0,
        input.eventAt,
        input.now,
        subscription.items.data[0]?.price.lookup_key ?? null,
        next?.priceKey ?? null,
        next?.at ?? null,
        next === undefined ? 0 : 1,
      ),
    // Follows the row just written, so a stale event changes neither. An
    // ended plan's end only moves earlier, so hearing of it again never
    // stretches it to the time of hearing.
    db
      .prepare(
        `UPDATE profiles SET plan_until = CASE WHEN ?5 THEN ?2 ELSE MIN(COALESCE(plan_until, ?2), ?2) END
         WHERE user_id = ?1 AND EXISTS (
           SELECT 1 FROM subscriptions WHERE user_id = ?1 AND subscription_id = ?3 AND event_at = ?4 AND status = ?6)`,
      )
      .bind(owner.user_id, until, subscription.id, input.eventAt, IN_FORCE.has(subscription.status) ? 1 : 0, subscription.status),
  ]);
  return true;
}

/** How long a checkout being made holds off another of the member's, at most. */
const CLAIM_SECONDS = 60;

/** The member's account, bound as ?1, is not deleted: what any checkout needs. */
const LIVE_ACCOUNT = `EXISTS (SELECT 1 FROM profiles WHERE user_id = ?1 AND deleted_at IS NULL)`;

export type CheckoutKind = "plan" | "fresh_start";

/** A request's hold on a member's checkout: its token proves it is the holder. */
export interface CheckoutClaim {
  userId: string;
  kind: CheckoutKind;
  token: string;
  /** When it was taken: past CLAIM_SECONDS, another request may take it over. */
  at: number;
}

/**
 * Holds the member's checkout of one kind while it is made, from looking
 * for a plan or an open checkout to making the new one, so two tabs cannot
 * both find nothing and both make one. Null while another request holds
 * it; a claim a minute old is taken over, should its request have died.
 * Null once the account is deleted, too: a request begun before its
 * deletion, which took no claim yet, makes no checkout after it.
 */
export async function claimCheckout(db: D1Database, userId: string, kind: CheckoutKind, now: number): Promise<CheckoutClaim | null> {
  const token = crypto.randomUUID();
  const claimed = await db
    .prepare(
      `INSERT INTO checkout_claims (user_id, kind, claimed_at, token, until)
       SELECT ?1, ?2, ?3, ?4, ?3 + ${CLAIM_SECONDS}
       WHERE ${LIVE_ACCOUNT}
       ON CONFLICT (user_id, kind) DO UPDATE SET claimed_at = excluded.claimed_at, token = excluded.token, until = excluded.until
       WHERE checkout_claims.until <= excluded.claimed_at`,
    )
    .bind(userId, kind, now, token)
    .run();
  return claimed.meta.changes > 0 ? { userId, kind, token, at: now } : null;
}

/** How long an account's deletion holds off its checkouts past its latest step. */
export const DELETION_HOLD_SECONDS = 600;

/**
 * Holds both of the member's checkouts for their account's deletion, or
 * renews the hold, under the deletion's own token: no checkout can start,
 * or be made by one already started, while it lasts. It is taken only where
 * no other claim is live, and each renewal makes it last
 * DELETION_HOLD_SECONDS more, so a deletion that renews it before every
 * step never loses it, and one that dies lets it lapse. Whether the token
 * holds both now.
 */
export async function holdForDeletion(db: D1Database, userId: string, token: string, now: number): Promise<boolean> {
  const take = (kind: CheckoutKind) =>
    db
      .prepare(
        `INSERT INTO checkout_claims (user_id, kind, claimed_at, token, until) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT (user_id, kind) DO UPDATE SET claimed_at = excluded.claimed_at, token = excluded.token, until = excluded.until
         WHERE checkout_claims.token = excluded.token OR checkout_claims.until <= excluded.claimed_at`,
      )
      .bind(userId, kind, now, token, now + DELETION_HOLD_SECONDS);
  const [, , held] = await db.batch([
    take("plan"),
    take("fresh_start"),
    db.prepare(`SELECT COUNT(*) AS held FROM checkout_claims WHERE user_id = ?1 AND token = ?2`).bind(userId, token),
  ]);
  return (held!.results[0] as { held: number }).held === 2;
}

/** Ends a deletion's hold, when the deletion does not go ahead. */
export async function releaseDeletionHold(db: D1Database, userId: string, token: string): Promise<void> {
  await db.prepare(`DELETE FROM checkout_claims WHERE user_id = ?1 AND token = ?2`).bind(userId, token).run();
}

/**
 * Whether the claim is still this request's, with time left to make the
 * checkout, and its account is not deleted: a request slower than the
 * claim's lifetime has lost it, and must make nothing.
 */
export async function stillHolding(db: D1Database, claim: CheckoutClaim, now: number): Promise<boolean> {
  if (now - claim.at >= CLAIM_SECONDS - 10) return false;
  const row = await db
    .prepare(`SELECT 1 FROM checkout_claims WHERE user_id = ?1 AND kind = ?2 AND token = ?3 AND ${LIVE_ACCOUNT}`)
    .bind(claim.userId, claim.kind, claim.token)
    .first();
  return row !== null;
}

/** Lets the member's next checkout of this kind be made, if this claim still holds it. */
export async function releaseCheckout(db: D1Database, claim: CheckoutClaim): Promise<void> {
  await db
    .prepare(`DELETE FROM checkout_claims WHERE user_id = ?1 AND kind = ?2 AND token = ?3`)
    .bind(claim.userId, claim.kind, claim.token)
    .run();
}

/**
 * Marks a checkout's return as having applied what it carried for the
 * member, such as a short name: true the first time only, so opening the
 * return address again changes nothing.
 */
export async function claimCheckoutReturn(db: D1Database, sessionId: string, userId: string, now: number): Promise<boolean> {
  const result = await db
    .prepare(`INSERT INTO checkout_returns (session_id, user_id, done_at) VALUES (?1, ?2, ?3) ON CONFLICT (session_id) DO NOTHING`)
    .bind(sessionId, userId, now)
    .run();
  return result.meta.changes > 0;
}

/** Undoes a claim whose work failed, so the return can be tried again. */
export async function releaseCheckoutReturn(db: D1Database, sessionId: string): Promise<void> {
  await db.prepare(`DELETE FROM checkout_returns WHERE session_id = ?1`).bind(sessionId).run();
}

/** The subscription to cancel when an account is deleted, if one is running. */
export async function runningSubscription(db: D1Database, userId: string): Promise<string | null> {
  const row = await db
    .prepare(
      `SELECT subscription_id FROM subscriptions
       WHERE user_id = ?1 AND subscription_id IS NOT NULL
         AND status IN ('active', 'trialing', 'past_due', 'incomplete', 'unpaid', 'paused')`,
    )
    .bind(userId)
    .first<{ subscription_id: string }>();
  return row?.subscription_id ?? null;
}

/** Shows or hides the fan mark beside the account's name. */
export async function setShowMark(db: D1Database, userId: string, show: boolean): Promise<void> {
  await db.prepare(`UPDATE profiles SET show_mark = ?2 WHERE user_id = ?1`).bind(userId, show ? 1 : 0).run();
}
