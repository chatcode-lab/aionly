import { env } from "cloudflare:workers";

import { type AccountRecord } from "../db/accounts.server";
import { readBodyCapped } from "../security/body";
import { applyFreshStart, type FreshStartOutcome } from "../db/fresh-starts.server";
import { recordPayment, recordRefund } from "../db/payments.server";
import {
  applySubscription,
  type CheckoutKind,
  claimCheckout,
  holdForDeletion,
  planStatus,
  releaseCheckout,
  releaseDeletionHold,
  rememberCustomer,
  stillHolding,
  runningSubscription,
} from "../db/subscriptions.server";
import { FRESH_START_PRICE, INTRO_PRICES, introEndsAt, PLAN_PRICES, type PlanInterval } from "../plan";
import {
  cancelSubscription,
  checkoutSubscription,
  createCheckout,
  createCustomer,
  createFreshStartCheckout,
  createPortal,
  expireOpenCheckouts,
  getCheckoutSession,
  getSubscription,
  invoiceOfPaymentIntent,
  isRunning,
  paidFreshStart,
  portalConfigurationFor,
  pricesByLookupKey,
  refundPayment,
  runningSubscriptions,
  type StripeCharge,
  type StripeCheckoutSession,
  type StripeInvoice,
  type StripeSubscription,
  stripeClient,
  verifyWebhook,
} from "./stripe";

const now = () => Math.floor(Date.now() / 1000);

/** Payments are open once the environment has a Stripe key. */
export function billingOpen(): boolean {
  return Boolean(env.STRIPE_SECRET_KEY);
}

function client() {
  if (!env.STRIPE_SECRET_KEY) throw new Error("STRIPE_SECRET_KEY is not set");
  return stripeClient(env.STRIPE_SECRET_KEY);
}

/** The account's Stripe customer, made on its first checkout with its sign-in email. */
async function customerFor(viewer: AccountRecord): Promise<string> {
  const known = await planStatus(env.DB, viewer.id);
  if (known.customerId) return known.customerId;
  const user = await env.DB.prepare(`SELECT "email" FROM "user" WHERE "id" = ?1`).bind(viewer.id).first<{ email: string }>();
  if (!user) throw new Error("account has no sign-in email");
  const customerId = await createCustomer(client(), { email: user.email, userId: viewer.id });
  await rememberCustomer(env.DB, { userId: viewer.id, customerId, now: now() });
  // Another request may have stored a customer first; that one wins.
  return (await planStatus(env.DB, viewer.id)).customerId ?? customerId;
}

/** A member who already pays for the plan, so is not sold a second one. */
export class AlreadySubscribed extends Error {}

/** Another of the member's requests is making a checkout of this kind right now. */
export class CheckoutBusy extends Error {}

/** What a member is told when another tab is making the same checkout. */
export const BUSY = "A checkout is already opening in another tab. Use that one, or try again in a minute.";

/**
 * Runs `make` while holding the member's checkout of this kind, so no other
 * is made meanwhile. `make` checks it still holds the claim (`holding`)
 * just before making the checkout, and names the attempt to Stripe, so a
 * request that outlived its claim, or is retried, makes no second one.
 */
async function holdingCheckout<T>(
  userId: string,
  kind: CheckoutKind,
  make: (attempt: { holding: () => Promise<void>; id: string }) => Promise<T>,
): Promise<T> {
  const claim = await claimCheckout(env.DB, userId, kind, now());
  if (!claim) throw new CheckoutBusy("a checkout is being made");
  try {
    return await make({
      id: claim.token,
      holding: async () => {
        if (!(await stillHolding(env.DB, claim, now()))) throw new CheckoutBusy("the claim lapsed");
      },
    });
  } finally {
    await releaseCheckout(env.DB, claim);
  }
}

/**
 * Past the end of a new member's prices, how long a checkout still gets
 * them, for someone who opened the plan's page in time.
 */
const INTRO_GRACE_SECONDS = 10 * 60;

/**
 * Stripe's checkout page for the plan, billed monthly or yearly, for a member
 * who asked for it to start at once, at a new member's price within
 * INTRO_HOURS of joining. One plan per member: a subscription
 * Stripe already has is applied instead, and any checkout left open is
 * closed first, so two tabs cannot buy two plans.
 */
export async function checkoutUrl(
  viewer: AccountRecord,
  interval: PlanInterval,
  origin: string,
  startNowAt: number,
  onReturn: { wantedName?: string | null; then?: string | null } = {},
): Promise<string> {
  const lookupKey = (now() < introEndsAt(viewer.createdAt) + INTRO_GRACE_SECONDS ? INTRO_PRICES : PLAN_PRICES)[interval].lookupKey;
  const prices = await pricesByLookupKey(client(), [lookupKey]);
  const priceId = prices.get(lookupKey);
  if (!priceId) throw new Error(`no active Stripe price has the lookup key ${lookupKey}`);
  const customerId = await customerFor(viewer);
  return holdingCheckout(viewer.id, "plan", async (attempt) => {
    const running = await runningSubscriptions(client(), customerId);
    if (running.length > 0) {
      for (const subscription of running) await applySubscription(env.DB, subscription, { eventAt: now(), now: now() });
      throw new AlreadySubscribed("this member already has a subscription");
    }
    await expireOpenCheckouts(client(), customerId);
    await attempt.holding();
    return createCheckout(client(), { customerId, priceId, userId: viewer.id, origin, startNowAt, attempt: attempt.id, ...onReturn });
  });
}

/** Stripe's checkout page for a fresh start, for a member who asked for it to apply at once. */
export async function freshStartCheckoutUrl(viewer: AccountRecord, origin: string, startNowAt: number): Promise<string> {
  const lookupKey = FRESH_START_PRICE.lookupKey;
  const priceId = (await pricesByLookupKey(client(), [lookupKey])).get(lookupKey);
  if (!priceId) throw new Error(`no active Stripe price has the lookup key ${lookupKey}`);
  const customerId = await customerFor(viewer);
  // Only the newest checkout can be paid, so one fresh start is bought at a time.
  return holdingCheckout(viewer.id, "fresh_start", async (attempt) => {
    await expireOpenCheckouts(client(), customerId);
    await attempt.holding();
    return createFreshStartCheckout(client(), { customerId, priceId, userId: viewer.id, origin, startNowAt, attempt: attempt.id });
  });
}

/**
 * Applies a paid fresh start, or refunds it in full when it came within the
 * cooldown of the last one: two payments can both go through, as from two
 * checkouts, and only one counts.
 */
async function settleFreshStart(session: StripeCheckoutSession, userId: string): Promise<FreshStartOutcome> {
  const outcome = await applyFreshStart(env.DB, { id: session.id, userId, source: "stripe", now: now() });
  // What it brought in, for the fund.
  if (outcome === "applied") {
    await recordPayment(env.DB, {
      id: session.id,
      userId,
      kind: "fresh_start",
      amountCents: session.amount_subtotal ?? FRESH_START_PRICE.cents,
      currency: session.currency ?? "usd",
      paidAt: now(),
      paymentIntent: session.payment_intent ?? null,
    });
  }
  if (outcome === "declined" && session.payment_intent) {
    await refundPayment(client(), session.payment_intent, "fresh start within 30 days of the last one");
  }
  return outcome;
}

/**
 * Applies the fresh start a finished checkout paid for, when the member
 * lands back here; the webhook does the same if this page is never reached.
 * Only the account that paid can finish it.
 */
export async function finishFreshStart(viewer: AccountRecord, sessionId: string): Promise<FreshStartOutcome> {
  const session = await getCheckoutSession(client(), sessionId);
  if (paidFreshStart(session) !== viewer.id) return "none";
  return settleFreshStart(session, viewer.id);
}

/** Stripe's customer portal, where a fan changes or cancels the plan. */
export async function portalUrl(viewer: AccountRecord, origin: string): Promise<string | null> {
  const { customerId, priceKey } = await planStatus(env.DB, viewer.id);
  if (!customerId) return null;
  // A plan at a new member's price switches only between those prices, in
  // the portal configuration marked for them; the default one switches
  // between the plan's own, so nobody moves onto a price not theirs.
  const intro = priceKey !== null && Object.values(INTRO_PRICES).some((price) => price.lookupKey === priceKey);
  const configuration = intro ? await portalConfigurationFor(client(), "intro") : env.STRIPE_PORTAL_CONFIGURATION;
  if (intro && !configuration) throw new Error("no billing portal configuration has the metadata aionly_prices=intro");
  return createPortal(client(), { customerId, returnUrl: `${origin}/settings`, configuration: configuration ?? undefined });
}

/**
 * Applies the subscription a finished checkout made, so the plan is on when
 * the fan lands back here, whether or not Stripe's webhook came first.
 * Only the account that started the checkout can finish it. With it come
 * what the checkout carried for the return: a short name and where to go.
 */
export async function finishCheckout(
  viewer: AccountRecord,
  sessionId: string,
): Promise<{ applied: boolean; wantedName: string | null; then: string | null }> {
  const { userId, subscription, wantedName, then } = await checkoutSubscription(client(), sessionId);
  if (userId !== viewer.id || !subscription) return { applied: false, wantedName: null, then: null };
  return { applied: await applySubscription(env.DB, subscription, { eventAt: now(), now: now() }), wantedName, then };
}

/**
 * Before an account is deleted: ends every subscription its customer has at
 * once, recorded or not, and closes any checkout left open, so it is never
 * charged again. Throws, so nothing is deleted, when a subscription is
 * running and Stripe cannot be reached to end it, or while a checkout is
 * being made.
 *
 * From the start, the deletion holds off every checkout of the member's,
 * renewing the hold before each step, however long Stripe takes. The hold
 * it returns was renewed last thing, and lasts through the deletion's own
 * write; `release` it if the deletion does not go ahead.
 */
export async function cancelForDeletion(userId: string): Promise<{ release: () => Promise<void> }> {
  const token = crypto.randomUUID();
  const release = () => releaseDeletionHold(env.DB, userId, token);
  const renew = async () => {
    if (!(await holdForDeletion(env.DB, userId, token, now()))) throw new CheckoutBusy("a checkout is being made");
  };
  try {
    await renew();
    const recorded = await runningSubscription(env.DB, userId);
    if (!env.STRIPE_SECRET_KEY) {
      if (recorded) throw new Error("a running subscription cannot be cancelled without STRIPE_SECRET_KEY");
      return { release };
    }
    const { customerId } = await planStatus(env.DB, userId);
    // Open checkouts close first, so one completing now becomes a
    // subscription the list below finds; one that completed as it closed
    // makes the close fail, and nothing is deleted.
    if (customerId) await expireOpenCheckouts(client(), customerId, renew);
    await renew();
    const targets = customerId ? await runningSubscriptions(client(), customerId) : [];
    // The one recorded here is ended too, should Stripe's list ever miss it.
    if (recorded && !targets.some((subscription) => subscription.id === recorded)) {
      await renew();
      const current = await getSubscription(client(), recorded);
      if (isRunning(current)) targets.push(current);
    }
    for (const subscription of targets) {
      await renew();
      const ended = await cancelSubscription(client(), subscription.id);
      await applySubscription(env.DB, ended, { eventAt: now(), now: now() });
    }
    await renew();
    return { release };
  } catch (error) {
    await release();
    throw error;
  }
}

const SUBSCRIPTION_EVENTS = new Set([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
]);

/** Records a paid invoice of a member's plan, before tax; one that paid nothing is left out. */
async function recordInvoice(invoice: StripeInvoice): Promise<void> {
  if (invoice.amount_paid <= 0) return;
  const member = await env.DB.prepare(`SELECT user_id FROM subscriptions WHERE customer_id = ?1`)
    .bind(invoice.customer)
    .first<{ user_id: string }>();
  if (!member) {
    console.error("stripe invoice for an unknown customer", invoice.id);
    return;
  }
  await recordPayment(env.DB, {
    id: invoice.id,
    userId: member.user_id,
    kind: "plan",
    amountCents: invoice.total_excluding_tax ?? invoice.subtotal,
    currency: invoice.currency,
    paidAt: invoice.status_transitions?.paid_at ?? now(),
  });
}

/**
 * Records a refund against the payment it refunds: a fresh start, by its
 * payment intent, or a plan's invoice, which Stripe names when asked.
 */
async function recordChargeRefund(charge: StripeCharge): Promise<void> {
  if (!charge.payment_intent) return;
  const refund = { paymentIntent: charge.payment_intent, refunded: charge.amount_refunded, paid: charge.amount };
  if (await recordRefund(env.DB, refund)) return;
  if (!env.STRIPE_SECRET_KEY) return;
  const invoice = await invoiceOfPaymentIntent(client(), charge.payment_intent);
  if (invoice) await recordRefund(env.DB, { ...refund, id: invoice });
}

/**
 * Stripe's webhook: every change to a subscription carries the whole
 * subscription, which is applied as Stripe's word on it, and a completed
 * checkout for a fresh start applies it. Answers 400 to an unsigned or
 * wrongly signed request, and 200 to anything else, so Stripe stops
 * retrying events the board has no use for.
 */
export async function handleWebhook(request: Request): Promise<Response> {
  // Read only so far before the signature is checked; Stripe's events are a few kilobytes.
  const payload = await readBodyCapped(request, 256 * 1024);
  if (payload === null) return Response.json({ error: "too_large" }, { status: 413 });
  const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!(await verifyWebhook(payload, request.headers.get("Stripe-Signature"), secret, now()))) {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }
  const event = JSON.parse(payload) as { type: string; created: number; data: { object: unknown } };
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    // Stripe's current word on the subscription, not the event's snapshot:
    // events can come late, out of order, or several in one second, and
    // the subscription as it is now settles them all alike. Without a key,
    // as in tests, the snapshot is all there is.
    const snapshot = event.data.object as StripeSubscription;
    const subscription = env.STRIPE_SECRET_KEY ? await getSubscription(client(), snapshot.id) : snapshot;
    await applySubscription(env.DB, subscription, { eventAt: event.created, now: now() });
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as StripeCheckoutSession;
    const userId = paidFreshStart(session);
    if (userId) await settleFreshStart(session, userId);
  }
  // A plan's payment, recorded for partners' shares.
  if (event.type === "invoice.paid") await recordInvoice(event.data.object as StripeInvoice);
  if (event.type === "charge.refunded") await recordChargeRefund(event.data.object as StripeCharge);
  return Response.json({ received: true });
}
