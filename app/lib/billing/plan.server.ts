import { env } from "cloudflare:workers";

import { type AccountRecord } from "../db/accounts.server";
import { readBodyCapped } from "../security/body";
import { applyFreshStart } from "../db/fresh-starts.server";
import { applySubscription, planStatus, rememberCustomer, runningSubscription } from "../db/subscriptions.server";
import { FRESH_START_PRICE, PLAN_PRICES, type PlanInterval } from "../plan";
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
  paidFreshStart,
  pricesByLookupKey,
  runningSubscriptions,
  type StripeCheckoutSession,
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

/**
 * Stripe's checkout page for the plan, billed monthly or yearly, for a member
 * who asked for it to start at once. One plan per member: a subscription
 * Stripe already has is applied instead, and any checkout left open is
 * closed first, so two tabs cannot buy two plans.
 */
export async function checkoutUrl(
  viewer: AccountRecord,
  interval: PlanInterval,
  origin: string,
  startNowAt: number,
): Promise<string> {
  const lookupKey = PLAN_PRICES[interval].lookupKey;
  const prices = await pricesByLookupKey(client(), [lookupKey]);
  const priceId = prices.get(lookupKey);
  if (!priceId) throw new Error(`no active Stripe price has the lookup key ${lookupKey}`);
  const customerId = await customerFor(viewer);
  const running = await runningSubscriptions(client(), customerId);
  if (running.length > 0) {
    for (const subscription of running) await applySubscription(env.DB, subscription, { eventAt: now(), now: now() });
    throw new AlreadySubscribed("this member already has a subscription");
  }
  await expireOpenCheckouts(client(), customerId);
  return createCheckout(client(), { customerId, priceId, userId: viewer.id, origin, startNowAt });
}

/** Stripe's checkout page for a fresh start, for a member who asked for it to apply at once. */
export async function freshStartCheckoutUrl(viewer: AccountRecord, origin: string, startNowAt: number): Promise<string> {
  const lookupKey = FRESH_START_PRICE.lookupKey;
  const priceId = (await pricesByLookupKey(client(), [lookupKey])).get(lookupKey);
  if (!priceId) throw new Error(`no active Stripe price has the lookup key ${lookupKey}`);
  const customerId = await customerFor(viewer);
  // Only the newest checkout can be paid, so one fresh start is bought at a time.
  await expireOpenCheckouts(client(), customerId);
  return createFreshStartCheckout(client(), { customerId, priceId, userId: viewer.id, origin, startNowAt });
}

/**
 * Applies the fresh start a finished checkout paid for, when the member
 * lands back here; the webhook does the same if this page is never reached.
 * Only the account that paid can finish it.
 */
export async function finishFreshStart(viewer: AccountRecord, sessionId: string): Promise<boolean> {
  const session = await getCheckoutSession(client(), sessionId);
  if (paidFreshStart(session) !== viewer.id) return false;
  return applyFreshStart(env.DB, { id: session.id, userId: viewer.id, source: "stripe", now: now() });
}

/** Stripe's customer portal, where a supporter changes or cancels the plan. */
export async function portalUrl(viewer: AccountRecord, origin: string): Promise<string | null> {
  const { customerId } = await planStatus(env.DB, viewer.id);
  if (!customerId) return null;
  return createPortal(client(), {
    customerId,
    returnUrl: `${origin}/settings`,
    configuration: env.STRIPE_PORTAL_CONFIGURATION,
  });
}

/**
 * Applies the subscription a finished checkout made, so the plan is on when
 * the supporter lands back here, whether or not Stripe's webhook came first.
 * Only the account that started the checkout can finish it.
 */
export async function finishCheckout(viewer: AccountRecord, sessionId: string): Promise<boolean> {
  const { userId, subscription } = await checkoutSubscription(client(), sessionId);
  if (userId !== viewer.id || !subscription) return false;
  return applySubscription(env.DB, subscription, { eventAt: now(), now: now() });
}

/**
 * Before an account is deleted: ends every subscription its customer has at
 * once, recorded or not, and closes any checkout left open, so it is never
 * charged again. Throws, so nothing is deleted, when a subscription is
 * running and Stripe cannot be reached to end it.
 */
export async function cancelForDeletion(userId: string): Promise<void> {
  const recorded = await runningSubscription(env.DB, userId);
  if (!env.STRIPE_SECRET_KEY) {
    if (recorded) throw new Error("a running subscription cannot be cancelled without STRIPE_SECRET_KEY");
    return;
  }
  const { customerId } = await planStatus(env.DB, userId);
  if (!customerId) return;
  await expireOpenCheckouts(client(), customerId);
  for (const subscription of await runningSubscriptions(client(), customerId)) {
    const ended = await cancelSubscription(client(), subscription.id);
    await applySubscription(env.DB, ended, { eventAt: now(), now: now() });
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
    if (userId) await applyFreshStart(env.DB, { id: session.id, userId, source: "stripe", now: now() });
  }
  return Response.json({ received: true });
}
