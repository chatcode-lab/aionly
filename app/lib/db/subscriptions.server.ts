import { intervalOf, periodEnd, type StripeSubscription } from "../billing/stripe";

/**
 * Days the plan stays in force past the end of the period paid for, so a
 * renewal that Stripe confirms late, or retries, interrupts nothing.
 */
export const PLAN_GRACE_SECONDS = 3 * 24 * 3600;

/** Stripe statuses under which the plan is in force. */
const IN_FORCE = new Set(["active", "trialing", "past_due"]);

/** An account's plan as Settings and the Supporter page show it. */
export interface PlanStatus {
  customerId: string | null;
  status: string | null;
  interval: "month" | "year" | null;
  periodEnd: number | null;
  cancelAtPeriodEnd: boolean;
}

export async function planStatus(db: D1Database, userId: string): Promise<PlanStatus> {
  const row = await db
    .prepare(
      `SELECT customer_id, status, interval, period_end, cancel_at_period_end FROM subscriptions WHERE user_id = ?1`,
    )
    .bind(userId)
    .first<{
      customer_id: string;
      status: string | null;
      interval: "month" | "year" | null;
      period_end: number | null;
      cancel_at_period_end: number;
    }>();
  return {
    customerId: row?.customer_id ?? null,
    status: row?.status ?? null,
    interval: row?.interval ?? null,
    periodEnd: row?.period_end ?? null,
    cancelAtPeriodEnd: row?.cancel_at_period_end === 1,
  };
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
  await db.batch([
    db
      .prepare(
        `INSERT INTO subscriptions (user_id, customer_id, subscription_id, status, interval, period_end,
           cancel_at_period_end, event_at, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
         ON CONFLICT (user_id) DO UPDATE SET
           customer_id = excluded.customer_id, subscription_id = excluded.subscription_id,
           status = excluded.status, interval = excluded.interval, period_end = excluded.period_end,
           cancel_at_period_end = excluded.cancel_at_period_end, event_at = excluded.event_at,
           updated_at = excluded.updated_at
         WHERE (subscriptions.event_at IS NULL OR subscriptions.event_at <= excluded.event_at)
           -- A late word about an old subscription never displaces one in force.
           AND (subscriptions.subscription_id IS NULL
             OR subscriptions.subscription_id = excluded.subscription_id
             OR subscriptions.status NOT IN ('active', 'trialing', 'past_due'))`,
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
      ),
    // Follows the row just written, so a stale event changes neither. An
    // ended plan's end only moves earlier, so hearing of it again never
    // stretches it to the time of hearing.
    db
      .prepare(
        `UPDATE profiles SET plan_until = CASE WHEN ?5 THEN ?2 ELSE MIN(COALESCE(plan_until, ?2), ?2) END
         WHERE user_id = ?1 AND EXISTS (
           SELECT 1 FROM subscriptions WHERE user_id = ?1 AND subscription_id = ?3 AND event_at = ?4)`,
      )
      .bind(owner.user_id, until, subscription.id, input.eventAt, IN_FORCE.has(subscription.status) ? 1 : 0),
  ]);
  return true;
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

/** Shows or hides the Supporter mark beside the account's name. */
export async function setShowMark(db: D1Database, userId: string, show: boolean): Promise<void> {
  await db.prepare(`UPDATE profiles SET show_mark = ?2 WHERE user_id = ?1`).bind(userId, show ? 1 : 0).run();
}
