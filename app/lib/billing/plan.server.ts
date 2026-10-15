import { env } from "cloudflare:workers";

import { type AccountRecord } from "../db/accounts.server";
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
  getCheckoutSession,
  paidFreshStart,
  pricesByLookupKey,
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

/**
 * Stripe's checkout page for the plan, billed monthly or yearly, for a member
 * who asked for it to start at once.
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
  return createCheckout(client(), { customerId: await customerFor(viewer), priceId, userId: viewer.id, origin, startNowAt });
}

/** Stripe's checkout page for a fresh start, for a member who asked for it to apply at once. */
export async function freshStartCheckoutUrl(viewer: AccountRecord, origin: string, startNowAt: number): Promise<string> {
  const lookupKey = FRESH_START_PRICE.lookupKey;
  const priceId = (await pricesByLookupKey(client(), [lookupKey])).get(lookupKey);
  if (!priceId) throw new Error(`no active Stripe price has the lookup key ${lookupKey}`);
  return createFreshStartCheckout(client(), { customerId: await customerFor(viewer), priceId, userId: viewer.id, origin, startNowAt });
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

/** Ends a deleted account's subscription at once, so it is never charged again. */
export async function cancelForDeletion(userId: string): Promise<void> {
  const subscriptionId = await runningSubscription(env.DB, userId);
  if (!subscriptionId || !env.STRIPE_SECRET_KEY) return;
  const ended = await cancelSubscription(client(), subscriptionId);
  await applySubscription(env.DB, ended, { eventAt: now(), now: now() });
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
  const payload = await request.text();
  const secret = env.STRIPE_WEBHOOK_SECRET ?? "";
  if (!(await verifyWebhook(payload, request.headers.get("Stripe-Signature"), secret, now()))) {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }
  const event = JSON.parse(payload) as { type: string; created: number; data: { object: unknown } };
  if (SUBSCRIPTION_EVENTS.has(event.type)) {
    const subscription = event.data.object as StripeSubscription;
    await applySubscription(env.DB, subscription, { eventAt: event.created, now: now() });
  }
  if (event.type === "checkout.session.completed" || event.type === "checkout.session.async_payment_succeeded") {
    const session = event.data.object as StripeCheckoutSession;
    const userId = paidFreshStart(session);
    if (userId) await applyFreshStart(env.DB, { id: session.id, userId, source: "stripe", now: now() });
  }
  return Response.json({ received: true });
}
