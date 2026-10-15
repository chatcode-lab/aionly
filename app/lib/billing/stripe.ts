/**
 * The few Stripe calls the Supporter plan needs, over Stripe's REST API with
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
 * address it collects, and a business can add its tax ID.
 */
export async function createCheckout(
  client: StripeClient,
  input: { customerId: string; priceId: string; userId: string; origin: string },
): Promise<string> {
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
    subscription_data: { metadata: { user_id: input.userId } },
    success_url: `${input.origin}/supporter/done?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/supporter`,
  });
  return session.url;
}

/** Stripe's page for changing the card, switching yearly, or cancelling. */
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
): Promise<{ userId: string | null; customerId: string | null; subscription: StripeSubscription | null }> {
  const session = await client.request<{
    client_reference_id: string | null;
    customer: string | null;
    subscription: StripeSubscription | null;
  }>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}`, { expand: ["subscription"] });
  return { userId: session.client_reference_id, customerId: session.customer, subscription: session.subscription };
}

export function getSubscription(client: StripeClient, id: string): Promise<StripeSubscription> {
  return client.request<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`);
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
