import { env } from "cloudflare:workers";

import { type AccountRecord, grantNameAllowance } from "../db/accounts.server";
import { readBodyCapped } from "../security/body";
import { applyFreshStart, type FreshStartOutcome } from "../db/fresh-starts.server";
import { paymentWithIntent, recordPayment, recordRefund } from "../db/payments.server";
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
import { FRESH_START_PRICE, INTRO_PRICES, introEndsAt, NAME_ALLOWANCES, PLAN_PRICES, type PlanInterval } from "../plan";
import {
  cancelSubscription,
  checkoutSubscription,
  createCheckout,
  createCustomer,
  createFreshStartCheckout,
  completedNameCheckouts,
  createNameCheckout,
  createPortal,
  expireOpenCheckouts,
  getCheckoutSession,
  getSubscription,
  invoiceOfPaymentIntent,
  invoiceSubscription,
  isRunning,
  lineCents,
  priceByLookupKey,
  paidFreshStart,
  paidNameAllowance,
  planCentsOf,
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
  const lookupKey = planLookupKey(viewer, interval);
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

/** The plan's price for the member now: a new member's within INTRO_HOURS of joining, and a little past. */
function planLookupKey(viewer: AccountRecord, interval: PlanInterval): string {
  return (now() < introEndsAt(viewer.createdAt) + INTRO_GRACE_SECONDS ? INTRO_PRICES : PLAN_PRICES)[interval].lookupKey;
}

/** The member has a short username already as short as the one asked for. */
export class AlreadyHasName extends Error {}

/** An earlier checkout for the name is complete, its payment still being confirmed. */
export class NamePending extends Error {}

/**
 * Stripe's checkout page for a short username, bought once for good, to
 * take `wantedName`: alone, or with the plan billed by `interval`, for a
 * member without one, at a new member's price while it lasts. Any checkout
 * left open is closed first, and it holds the plan's checkout claim, so
 * two tabs cannot buy two plans.
 */
export async function nameCheckoutUrl(
  viewer: AccountRecord,
  input: { length: number; wantedName: string; interval: PlanInterval | null; origin: string; startNowAt: number; then?: string | null },
): Promise<string> {
  const allowance = NAME_ALLOWANCES[input.length];
  if (!allowance) throw new Error(`no short username of ${input.length} characters is sold`);
  if (viewer.nameAllowance !== null && viewer.nameAllowance <= input.length) throw new AlreadyHasName("bought already");
  const name = await priceByLookupKey(client(), allowance.lookupKey);
  if (!name) throw new Error(`no active Stripe price has the lookup key ${allowance.lookupKey}`);
  const planKey = input.interval ? planLookupKey(viewer, input.interval) : null;
  const planPriceId = planKey ? (await pricesByLookupKey(client(), [planKey])).get(planKey) : null;
  if (planKey && !planPriceId) throw new Error(`no active Stripe price has the lookup key ${planKey}`);
  const customerId = await customerFor(viewer);
  return holdingCheckout(viewer.id, "plan", async (attempt) => {
    // A checkout already paid, not yet applied, is applied now rather than
    // sold again; one still being paid waits; one whose payment failed is
    // no hindrance (reviews F81, F84).
    for (const done of await completedNameCheckouts(client(), customerId)) {
      if (done.state === "paid") await settleNameAllowance(done.session);
      else if (done.state === "pending") throw new NamePending("an earlier checkout is being paid");
    }
    const bought = await env.DB.prepare(`SELECT name_allowance FROM profiles WHERE user_id = ?1`)
      .bind(viewer.id)
      .first<{ name_allowance: number | null }>();
    if (bought?.name_allowance != null && bought.name_allowance <= input.length) throw new AlreadyHasName("bought already");
    if (planKey) {
      const running = await runningSubscriptions(client(), customerId);
      if (running.length > 0) {
        for (const subscription of running) await applySubscription(env.DB, subscription, { eventAt: now(), now: now() });
        throw new AlreadySubscribed("this member already has a subscription");
      }
    }
    await expireOpenCheckouts(client(), customerId);
    await attempt.holding();
    return createNameCheckout(client(), {
      customerId,
      namePriceId: name.id,
      nameCents: name.unitAmount ?? allowance.cents,
      length: input.length,
      planPriceId: planPriceId ?? null,
      userId: viewer.id,
      origin: input.origin,
      startNowAt: input.startNowAt,
      wantedName: input.wantedName,
      attempt: attempt.id,
      then: input.then,
    });
  });
}

/**
 * Gives the member the short username a paid checkout bought, whether the
 * member lands back here or Stripe's webhook comes first, with what it
 * came to before tax, after any promotion code, and the invoice it shares
 * with the plan. A second payment for a name already bought is refunded
 * when it was paid alone; one billed with the plan is left to the
 * operator, who refunds its line (review F81). Whether one was given.
 */
async function settleNameAllowance(session: StripeCheckoutSession): Promise<boolean> {
  const bought = paidNameAllowance(session);
  if (!bought) return false;
  const cents = await nameCents(session, bought);
  const result = await grantNameAllowance(env.DB, {
    userId: bought.userId,
    length: bought.length,
    sessionId: session.id,
    cents,
    currency: session.currency ?? "usd",
    paidAt: now(),
    paymentIntent: session.payment_intent ?? null,
    invoiceId: session.mode === "subscription" ? (session.invoice ?? null) : null,
  });
  if (result.duplicate && cents > 0) {
    if (session.mode === "payment" && session.payment_intent) {
      if (env.STRIPE_SECRET_KEY) await refundPayment(client(), session.payment_intent, "the 4-letter username was bought already");
    } else {
      console.error("4-letter username bought again with the plan: refund its line by hand", session.id);
    }
  }
  return result.granted;
}

/**
 * What a short username's checkout charged for it, before tax, after any
 * promotion code: the whole session's, alone, or its own line's, with the
 * plan. Without a Stripe key, as in tests, its price as the session carried it.
 */
async function nameCents(session: StripeCheckoutSession, bought: { length: number; cents: number }): Promise<number> {
  if (session.mode === "payment" && session.amount_subtotal != null) {
    return session.amount_subtotal - (session.total_details?.amount_discount ?? 0);
  }
  const lookupKey = NAME_ALLOWANCES[bought.length]?.lookupKey;
  if (!env.STRIPE_SECRET_KEY || !lookupKey) return bought.cents;
  return (await lineCents(client(), session.id, lookupKey)) ?? bought.cents;
}

/**
 * Stripe's checkout page for a fresh start, for a member who asked for it to
 * apply at once, at the amount they chose: the fresh start's price or more.
 */
export async function freshStartCheckoutUrl(
  viewer: AccountRecord,
  origin: string,
  startNowAt: number,
  amountCents: number = FRESH_START_PRICE.cents,
): Promise<string> {
  const lookupKey = FRESH_START_PRICE.lookupKey;
  const price = await priceByLookupKey(client(), lookupKey);
  if (!price) throw new Error(`no active Stripe price has the lookup key ${lookupKey}`);
  const amount = Math.max(amountCents, price.unitAmount ?? FRESH_START_PRICE.cents);
  const customerId = await customerFor(viewer);
  // Only the newest checkout can be paid, so one fresh start is bought at a time.
  return holdingCheckout(viewer.id, "fresh_start", async (attempt) => {
    await expireOpenCheckouts(client(), customerId);
    await attempt.holding();
    return createFreshStartCheckout(client(), {
      customerId,
      productId: price.product,
      amountCents: amount,
      userId: viewer.id,
      origin,
      startNowAt,
      attempt: attempt.id,
    });
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
 * Applies what a finished checkout bought, so it is on when the member
 * lands back here, whether or not Stripe's webhook came first: the
 * subscription it made, and a short username paid for with or without it.
 * Only the account that started the checkout can finish it. With it come
 * what the checkout carried for the return: a short name and where to go.
 */
export async function finishCheckout(
  viewer: AccountRecord,
  sessionId: string,
): Promise<{ applied: boolean; plan: boolean; name: boolean; wantedName: string | null; then: string | null }> {
  const { userId, subscription, wantedName, then, session } = await checkoutSubscription(client(), sessionId);
  const none = { applied: false, plan: false, name: false, wantedName: null, then: null };
  if (userId !== viewer.id) return none;
  const name = paidNameAllowance(session) !== null && (await settleNameAllowance(session));
  const plan = subscription ? await applySubscription(env.DB, subscription, { eventAt: now(), now: now() }) : false;
  // A checkout that bought the name with the plan waits for both.
  const applied = subscription ? plan && (name || paidNameAllowance(session) === null) : name;
  return applied ? { applied, plan, name, wantedName, then } : none;
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

/**
 * Records a paid invoice of a member's plan, before tax. Only a
 * subscription's invoice is the plan's: a fresh start's checkout makes a
 * one-time invoice too, which the fund counts by its checkout, never as
 * plan revenue a partner shares, and a short username bought with the plan
 * is on its first invoice, which counts its subscription lines alone. One
 * that paid nothing for the plan is left out.
 */
async function recordInvoice(invoice: StripeInvoice): Promise<void> {
  const planCents = planCentsOf(invoice);
  if (invoice.amount_paid <= 0 || planCents <= 0 || !invoiceSubscription(invoice)) return;
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
    amountCents: planCents,
    currency: invoice.currency,
    paidAt: invoice.status_transitions?.paid_at ?? now(),
  });
}

/**
 * Records a refund against the payment it refunds: a fresh start, by its
 * payment intent, or a plan's invoice, which Stripe names when asked. It is
 * kept either way, so a payment recorded later takes it.
 */
async function recordChargeRefund(charge: StripeCharge): Promise<void> {
  if (!charge.payment_intent) return;
  const known = await paymentWithIntent(env.DB, charge.payment_intent);
  const invoiceId = !known && env.STRIPE_SECRET_KEY ? await invoiceOfPaymentIntent(client(), charge.payment_intent) : null;
  await recordRefund(env.DB, {
    chargeId: charge.id,
    paymentIntent: charge.payment_intent,
    invoiceId,
    refunded: charge.amount_refunded,
    paid: charge.amount,
    now: now(),
  });
}

/**
 * Stripe's webhook: every change to a subscription carries the whole
 * subscription, which is applied as Stripe's word on it, and a completed
 * checkout for a fresh start or a short username applies it. Answers 400
 * to an unsigned or wrongly signed request, and 200 to anything else, so
 * Stripe stops retrying events the board has no use for.
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
    await settleNameAllowance(session);
  }
  // A plan's payment, recorded for partners' shares.
  if (event.type === "invoice.paid") await recordInvoice(event.data.object as StripeInvoice);
  if (event.type === "charge.refunded") await recordChargeRefund(event.data.object as StripeCharge);
  return Response.json({ received: true });
}
