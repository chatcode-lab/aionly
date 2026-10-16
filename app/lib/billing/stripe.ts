/**
 * The few Stripe calls the Fan plan needs, over Stripe's REST API with
 * `fetch`, so the Worker carries no SDK. Requests are form-encoded, answers
 * are JSON, and the API version is pinned so answers keep their shape.
 */

const API = "https://api.stripe.com/v1";
const API_VERSION = "2025-03-31.basil";

/** Webhook signatures older than this are refused, as Stripe advises. */
const SIGNATURE_TOLERANCE_SECONDS = 300;

export class StripeError extends Error {
  constructor(
    readonly status: number,
    readonly code: string | undefined,
    message: string,
  ) {
    super(message);
  }
}

type Param = string | number | boolean | null | undefined | Param[] | { [key: string]: Param };

/** Stripe's form encoding: `a[b][0]=c` for nested objects and lists. */
export function encodeForm(params: Record<string, Param>): URLSearchParams {
  const form = new URLSearchParams();
  const add = (key: string, value: Param) => {
    if (value === undefined || value === null) return;
    if (Array.isArray(value)) value.forEach((item, index) => add(`${key}[${index}]`, item));
    else if (typeof value === "object") for (const [inner, item] of Object.entries(value)) add(`${key}[${inner}]`, item);
    else form.append(key, String(value));
  };
  for (const [key, value] of Object.entries(params)) add(key, value);
  return form;
}

export interface StripeClient {
  request<T>(method: "GET" | "POST" | "DELETE", path: string, params?: Record<string, Param>, idempotencyKey?: string): Promise<T>;
}

export function stripeClient(secretKey: string, fetcher: typeof fetch = fetch): StripeClient {
  return {
    async request<T>(method: "GET" | "POST" | "DELETE", path: string, params: Record<string, Param> = {}, idempotencyKey?: string) {
      const form = encodeForm(params);
      const url = method === "POST" || form.size === 0 ? `${API}${path}` : `${API}${path}?${form}`;
      const headers: Record<string, string> = {
        Authorization: `Bearer ${secretKey}`,
        "Stripe-Version": API_VERSION,
      };
      if (method === "POST") headers["Content-Type"] = "application/x-www-form-urlencoded";
      if (idempotencyKey) headers["Idempotency-Key"] = idempotencyKey;
      const response = await fetcher(url, {
        method,
        headers,
        body: method === "POST" ? form : undefined,
        signal: AbortSignal.timeout(10_000),
      });
      const body = (await response.json()) as T & { error?: { code?: string; message?: string } };
      if (!response.ok) {
        throw new StripeError(response.status, body.error?.code, body.error?.message ?? `Stripe answered ${response.status}`);
      }
      return body;
    },
  };
}

/** A subscription as the board reads it from Stripe. */
export interface StripeSubscription {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  metadata?: Record<string, string>;
  /** Before API version 2025-03-31, the period sat on the subscription. */
  current_period_end?: number;
  items: {
    data: Array<{
      current_period_end?: number;
      price: { id: string; lookup_key: string | null; recurring: { interval: string } | null };
    }>;
  };
}

/** The end of the period paid for, wherever this API version keeps it. */
export function periodEnd(subscription: StripeSubscription): number | null {
  return subscription.items.data[0]?.current_period_end ?? subscription.current_period_end ?? null;
}

export function intervalOf(subscription: StripeSubscription): "month" | "year" | null {
  const interval = subscription.items.data[0]?.price.recurring?.interval;
  return interval === "month" || interval === "year" ? interval : null;
}

/** The price IDs for these lookup keys, or null for any not found. */
export async function pricesByLookupKey(client: StripeClient, keys: string[]): Promise<Map<string, string>> {
  const { data } = await client.request<{ data: Array<{ id: string; lookup_key: string | null }> }>("GET", "/prices", {
    lookup_keys: keys,
    active: true,
  });
  return new Map(data.filter((price) => price.lookup_key).map((price) => [price.lookup_key!, price.id]));
}

export async function createCustomer(client: StripeClient, input: { email: string; userId: string }): Promise<string> {
  const customer = await client.request<{ id: string }>(
    "POST",
    "/customers",
    { email: input.email, metadata: { user_id: input.userId } },
    `customer-${input.userId}`,
  );
  return customer.id;
}

/**
 * A hosted checkout for the plan. Stripe works out VAT or sales tax from the
 * address it collects, and a business can add its tax ID. A new member's
 * checkout from the welcome step carries the short name they asked for
 * (`wantedName`) and where they were going (`then`), for the return.
 */
export async function createCheckout(
  client: StripeClient,
  input: {
    customerId: string;
    priceId: string;
    userId: string;
    origin: string;
    startNowAt: number;
    attempt?: string;
    wantedName?: string | null;
    then?: string | null;
  },
): Promise<string> {
  // The member asked for the plan to start at once, by starting it, which
  // consumer law needs before a withdrawal can be refunded less the days
  // used. Kept with the subscription, as the record of it.
  const metadata = { user_id: input.userId, start_now_requested_at: String(input.startNowAt) };
  const onReturn = {
    ...(input.wantedName ? { wanted_name: input.wantedName } : {}),
    ...(input.then ? { then: input.then } : {}),
  };
  const session = await client.request<{ url: string }>("POST", "/checkout/sessions", {
    mode: "subscription",
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    automatic_tax: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true },
    billing_address_collection: "auto",
    allow_promotion_codes: true,
    metadata: { ...metadata, ...onReturn },
    subscription_data: { metadata },
    success_url: `${input.origin}/fan/done?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/fan`,
  }, input.attempt ? `checkout-${input.attempt}` : undefined);
  return session.url;
}

/**
 * A hosted checkout for a fresh start: one payment, with tax worked out as
 * for the plan. The member asked for it to apply at once, which ends the
 * right of withdrawal once it does; the time is kept with the payment.
 */
export async function createFreshStartCheckout(
  client: StripeClient,
  input: { customerId: string; priceId: string; userId: string; origin: string; startNowAt: number; attempt?: string },
): Promise<string> {
  const metadata = { user_id: input.userId, kind: "fresh_start", start_now_requested_at: String(input.startNowAt) };
  const session = await client.request<{ url: string }>("POST", "/checkout/sessions", {
    mode: "payment",
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [{ price: input.priceId, quantity: 1 }],
    automatic_tax: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true },
    billing_address_collection: "auto",
    invoice_creation: { enabled: true },
    metadata,
    payment_intent_data: { metadata },
    success_url: `${input.origin}/fresh-start/done?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/fresh-start`,
  }, input.attempt ? `fresh-start-${input.attempt}` : undefined);
  return session.url;
}

/** A finished checkout session, as the fresh start reads it. */
export interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  mode: string;
  client_reference_id: string | null;
  payment_status: string;
  payment_intent?: string | null;
  metadata?: Record<string, string> | null;
}

export function getCheckoutSession(client: StripeClient, id: string): Promise<StripeCheckoutSession> {
  return client.request<StripeCheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(id)}`);
}

/** Whether a session is a fresh start that has been paid for, and by whom. */
export function paidFreshStart(session: StripeCheckoutSession): string | null {
  if (session.mode !== "payment" || session.metadata?.kind !== "fresh_start") return null;
  if (session.payment_status !== "paid") return null;
  return session.client_reference_id ?? session.metadata?.user_id ?? null;
}

/** Stripe's page for changing the card, switching yearly, or cancelling. */
/**
 * The active billing portal configuration whose metadata names the prices
 * it switches between (`aionly_prices`), or null when none does.
 */
export async function portalConfigurationFor(client: StripeClient, prices: "intro" | "standard"): Promise<string | null> {
  const { data } = await client.request<{ data: Array<{ id: string; metadata?: Record<string, string> | null }> }>(
    "GET",
    "/billing_portal/configurations",
    { active: true, limit: 100 },
  );
  return data.find((configuration) => configuration.metadata?.aionly_prices === prices)?.id ?? null;
}

export async function createPortal(
  client: StripeClient,
  input: { customerId: string; returnUrl: string; configuration?: string },
): Promise<string> {
  const session = await client.request<{ url: string }>("POST", "/billing_portal/sessions", {
    customer: input.customerId,
    return_url: input.returnUrl,
    configuration: input.configuration || undefined,
  });
  return session.url;
}

export async function checkoutSubscription(
  client: StripeClient,
  sessionId: string,
): Promise<{
  userId: string | null;
  customerId: string | null;
  subscription: StripeSubscription | null;
  /** What the checkout carried for the return: a short name asked for, and where to go. */
  wantedName: string | null;
  then: string | null;
}> {
  const session = await client.request<{
    client_reference_id: string | null;
    customer: string | null;
    subscription: StripeSubscription | null;
    metadata?: Record<string, string> | null;
  }>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ["subscription"] });
  return {
    userId: session.client_reference_id,
    customerId: session.customer,
    subscription: session.subscription,
    wantedName: session.metadata?.wanted_name ?? null,
    then: session.metadata?.then ?? null,
  };
}

export function getSubscription(client: StripeClient, id: string): Promise<StripeSubscription> {
  return client.request<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
}

/** Stripe statuses under which a subscription may still charge. */
const RUNNING = new Set(["active", "trialing", "past_due", "incomplete", "unpaid", "paused"]);

/** Whether a subscription may still charge. */
export function isRunning(subscription: StripeSubscription): boolean {
  return RUNNING.has(subscription.status);
}

/** Pages of a list read at most: 2,000 items, far more than one customer has. */
const MAX_PAGES = 20;

/**
 * Every item of one of Stripe's lists, page after page. It throws rather
 * than answer with part of a list, since callers act on all of it.
 */
async function listAll<T extends { id: string }>(
  client: StripeClient,
  path: string,
  params: Record<string, Param>,
): Promise<T[]> {
  const items: T[] = [];
  let after: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { data, has_more } = await client.request<{ data: T[]; has_more?: boolean }>("GET", path, {
      ...params,
      limit: 100,
      starting_after: after,
    });
    items.push(...data);
    if (!has_more || data.length === 0) return items;
    after = data[data.length - 1]!.id;
  }
  throw new StripeError(500, "list_too_long", `${path} lists more than ${MAX_PAGES * 100} items`);
}

/** The customer's subscriptions that may still charge, whatever the board has recorded. */
export async function runningSubscriptions(client: StripeClient, customerId: string): Promise<StripeSubscription[]> {
  const all = await listAll<StripeSubscription>(client, "/subscriptions", { customer: customerId, status: "all" });
  return all.filter(isRunning);
}

/**
 * Closes the customer's checkouts still open, in another tab or left
 * unfinished, so only the next one can be paid.
 */
export async function expireOpenCheckouts(
  client: StripeClient,
  customerId: string,
  beforeEach?: () => Promise<void>,
): Promise<void> {
  const open = await listAll<{ id: string }>(client, "/checkout/sessions", { customer: customerId, status: "open" });
  for (const session of open) {
    await beforeEach?.();
    await client.request("POST", `/checkout/sessions/${encodeURIComponent(session.id)}/expire`);
  }
}

/**
 * Refunds a one-time payment in full, once however often it is asked for:
 * a fresh start paid for within the cooldown of the last one.
 */
export async function refundPayment(client: StripeClient, paymentIntent: string, reason: string): Promise<void> {
  try {
    await client.request(
      "POST",
      "/refunds",
      { payment_intent: paymentIntent, reason: "duplicate", metadata: { why: reason } },
      `refund-${paymentIntent}`,
    );
  } catch (error) {
    // Refunded already, as by an earlier call: done.
    if (error instanceof StripeError && error.code === "charge_already_refunded") return;
    throw error;
  }
}

/** Ends a subscription at once, as when its account is deleted. */
export function cancelSubscription(client: StripeClient, id: string): Promise<StripeSubscription> {
  return client.request<StripeSubscription>("DELETE", `/subscriptions/${encodeURIComponent(id)}`);
}

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function equalInConstantTime(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let index = 0; index < a.length; index += 1) difference |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return difference === 0;
}

/** Signs a payload as Stripe does; tests use it to send webhooks. */
export async function signWebhook(payload: string, secret: string, timestamp: number): Promise<string> {
  return `t=${timestamp},v1=${await hmacHex(secret, `${timestamp}.${payload}`)}`;
}

/**
 * Checks a webhook's `Stripe-Signature`: one of its `v1` signatures must be
 * the payload's HMAC under the endpoint's secret, made within five minutes.
 */
export async function verifyWebhook(payload: string, header: string | null, secret: string, now: number): Promise<boolean> {
  if (!header || !secret) return false;
  const parts = header.split(",").map((part) => part.split("=", 2) as [string, string | undefined]);
  const timestamp = Number(parts.find(([name]) => name === "t")?.[1]);
  if (!Number.isInteger(timestamp) || Math.abs(now - timestamp) > SIGNATURE_TOLERANCE_SECONDS) return false;
  const expected = await hmacHex(secret, `${timestamp}.${payload}`);
  return parts.some(([name, value]) => name === "v1" && value !== undefined && equalInConstantTime(value, expected));
}
