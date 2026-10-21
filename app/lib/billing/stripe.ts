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
    /** Stripe's kind of error: a `card_error`'s message is written for the cardholder. */
    readonly type?: string,
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
      const body = (await response.json()) as T & { error?: { code?: string; message?: string; type?: string } };
      if (!response.ok) {
        throw new StripeError(response.status, body.error?.code, body.error?.message ?? `Stripe answered ${response.status}`, body.error?.type);
      }
      return body;
    },
  };
}

/** A price as a schedule's phase names it, expanded. */
interface PhasePrice {
  id: string;
  lookup_key: string | null;
}

/** A subscription schedule as the board reads it: its phases, each price expanded. */
export interface StripeSchedule {
  id: string;
  metadata?: Record<string, string>;
  /** What becomes of the subscription when the last phase ends. */
  end_behavior?: string;
  current_phase: { start_date: number; end_date: number } | null;
  phases: Array<{
    start_date: number;
    end_date: number;
    items: Array<{ price: string | PhasePrice; quantity?: number }>;
    discounts?: Array<{ coupon?: string | null; discount?: string | null; promotion_code?: string | null }>;
  }>;
}

/** A subscription as the board reads it from Stripe. */
export interface StripeSubscription {
  id: string;
  object: "subscription";
  customer: string;
  status: string;
  cancel_at_period_end: boolean;
  /** When it is set to end, by date or by a schedule ending it. */
  cancel_at?: number | null;
  metadata?: Record<string, string>;
  /** Its schedule, expanded when read through getSubscription; an ID otherwise. */
  schedule?: string | StripeSchedule | null;
  automatic_tax?: { enabled: boolean };
  /** Before API version 2025-03-31, the period sat on the subscription. */
  current_period_end?: number;
  items: {
    data: Array<{
      /** The item's own ID, which a change of price names. */
      id?: string;
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

/** A price by its lookup key, with its product and amount, if active. */
export async function priceByLookupKey(
  client: StripeClient,
  key: string,
): Promise<{ id: string; product: string; unitAmount: number | null } | null> {
  const { data } = await client.request<{ data: Array<{ id: string; product: string; unit_amount: number | null }> }>("GET", "/prices", {
    lookup_keys: [key],
    active: true,
  });
  const price = data[0];
  return price ? { id: price.id, product: price.product, unitAmount: price.unit_amount } : null;
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
  input: {
    customerId: string;
    /** The fresh start's product, and the amount the member chose, before tax, in cents. */
    productId: string;
    amountCents: number;
    userId: string;
    origin: string;
    startNowAt: number;
    attempt?: string;
  },
): Promise<string> {
  const metadata = { user_id: input.userId, kind: "fresh_start", start_now_requested_at: String(input.startNowAt) };
  const session = await client.request<{ url: string }>("POST", "/checkout/sessions", {
    mode: "payment",
    customer: input.customerId,
    client_reference_id: input.userId,
    line_items: [
      {
        price_data: { currency: "usd", product: input.productId, unit_amount: input.amountCents, tax_behavior: "exclusive" },
        quantity: 1,
      },
    ],
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

/** What a checkout for a short username carries in its metadata. */
const NAME_ALLOWANCE_KIND = "name_allowance";

/**
 * A hosted checkout for a username shorter than the plan allows, bought
 * once (see NAME_ALLOWANCES): alone, as one payment, or with the plan, as
 * the plan's checkout with the name's price on its first invoice. The
 * member asked for the name at once, which ends the right of withdrawal
 * for it once it is theirs; the time is kept with the payment. Promotion
 * codes are taken, so an admin can give the name away, as to a guest
 * editor, with a code for all of it.
 */
export async function createNameCheckout(
  client: StripeClient,
  input: {
    customerId: string;
    /** The name's price, and its amount before tax, in cents. */
    namePriceId: string;
    nameCents: number;
    /** The shortest name it allows. */
    length: number;
    /** The plan's price, to subscribe at the same time, or null. */
    planPriceId: string | null;
    userId: string;
    origin: string;
    startNowAt: number;
    wantedName: string;
    attempt?: string;
    then?: string | null;
  },
): Promise<string> {
  const metadata = { user_id: input.userId, start_now_requested_at: String(input.startNowAt) };
  const name = {
    kind: NAME_ALLOWANCE_KIND,
    name_length: String(input.length),
    name_cents: String(input.nameCents),
    wanted_name: input.wantedName,
    ...(input.then ? { then: input.then } : {}),
  };
  const common = {
    customer: input.customerId,
    client_reference_id: input.userId,
    automatic_tax: { enabled: true },
    customer_update: { address: "auto", name: "auto" },
    tax_id_collection: { enabled: true },
    billing_address_collection: "auto",
    allow_promotion_codes: true,
    metadata: { ...metadata, ...name },
    success_url: `${input.origin}/fan/done?session={CHECKOUT_SESSION_ID}`,
    cancel_url: `${input.origin}/fan?${new URLSearchParams({ name: input.wantedName })}`,
  };
  const session = await client.request<{ url: string }>(
    "POST",
    "/checkout/sessions",
    input.planPriceId
      ? {
          ...common,
          mode: "subscription",
          line_items: [
            { price: input.planPriceId, quantity: 1 },
            { price: input.namePriceId, quantity: 1 },
          ],
          subscription_data: { metadata },
        }
      : {
          ...common,
          mode: "payment",
          line_items: [{ price: input.namePriceId, quantity: 1 }],
          invoice_creation: { enabled: true },
          payment_intent_data: { metadata: { ...metadata, kind: NAME_ALLOWANCE_KIND } },
        },
    input.attempt ? `name-${input.attempt}` : undefined,
  );
  return session.url;
}

/** A finished checkout session, as the board reads it. */
export interface StripeCheckoutSession {
  id: string;
  object: "checkout.session";
  mode: string;
  client_reference_id: string | null;
  payment_status: string;
  payment_intent?: string | null;
  metadata?: Record<string, string> | null;
  /** Before tax, in the currency's smallest unit. */
  amount_subtotal?: number | null;
  currency?: string | null;
  /** The subscription it made, when expanded. */
  subscription?: StripeSubscription | string | null;
  /** Discounts and tax over the whole session, in the currency's smallest unit. */
  total_details?: { amount_discount?: number | null } | null;
  /** The invoice it made: with a subscription, its first, which the plan's payment is recorded under. */
  invoice?: string | null;
}

/** Payment intent statuses of a payment still under way, which may yet succeed. */
const PAYING = new Set(["processing", "requires_action", "requires_confirmation", "requires_capture", "succeeded"]);

/**
 * Statuses of a bundled checkout's first invoice while its payment may yet
 * go through. One that failed is voided, though the subscription it began
 * can stay active (review F84).
 */
const INVOICE_PAYING = new Set(["draft", "open", "paid"]);

/**
 * The customer's completed checkouts for a short username, each with where
 * its payment stands: `paid`; `pending`, a delayed payment Stripe is still
 * confirming; or `failed`, one that will not go through, which blocks
 * nothing (review F84). Bought alone, that is its payment intent's state;
 * with the plan, its first invoice's, never the subscription's, which can
 * outlive a failed first payment. Read as Stripe has them now, so a member is not
 * sold one they bought already, nor kept from buying after a failure
 * (review F81).
 */
export async function completedNameCheckouts(
  client: StripeClient,
  customerId: string,
): Promise<Array<{ session: StripeCheckoutSession; state: "paid" | "pending" | "failed" }>> {
  const all = await listAll<
    Omit<StripeCheckoutSession, "payment_intent" | "subscription" | "invoice"> & {
      payment_intent?: { id: string; status: string } | string | null;
      subscription?: { id: string; status: string } | string | null;
      invoice?: { id: string; status: string | null } | string | null;
    }
  >(client, "/checkout/sessions", {
    customer: customerId,
    status: "complete",
    expand: ["data.payment_intent", "data.subscription", "data.invoice"],
  });
  return all
    .filter((session) => session.metadata?.kind === NAME_ALLOWANCE_KIND)
    .map((listed) => {
      const intent = typeof listed.payment_intent === "object" ? listed.payment_intent : null;
      const subscription = typeof listed.subscription === "object" ? listed.subscription : null;
      const invoice = typeof listed.invoice === "object" ? listed.invoice : null;
      const session: StripeCheckoutSession = {
        ...listed,
        payment_intent: intent?.id ?? (typeof listed.payment_intent === "string" ? listed.payment_intent : null),
        subscription: subscription?.id ?? (typeof listed.subscription === "string" ? listed.subscription : null),
        invoice: invoice?.id ?? (typeof listed.invoice === "string" ? listed.invoice : null),
      };
      if (paidNameAllowance(session)) return { session, state: "paid" as const };
      // Without its invoice, only a subscription still incomplete is waiting on its first payment.
      const paying =
        session.mode === "subscription"
          ? invoice
            ? INVOICE_PAYING.has(invoice.status ?? "")
            : subscription?.status === "incomplete"
          : PAYING.has(intent?.status ?? "");
      return { session, state: paying ? ("pending" as const) : ("failed" as const) };
    });
}

/**
 * Whether a session paid for a short username, and for whom, with the
 * shortest name it allows and its price before tax: alone or with the
 * plan, once its payment has gone through, or when a promotion code left
 * nothing to pay.
 */
export function paidNameAllowance(
  session: StripeCheckoutSession,
): { userId: string; length: number; cents: number; wantedName: string | null } | null {
  if (session.metadata?.kind !== NAME_ALLOWANCE_KIND) return null;
  if (session.payment_status !== "paid" && session.payment_status !== "no_payment_required") return null;
  const userId = session.client_reference_id ?? session.metadata?.user_id ?? null;
  const length = Number(session.metadata?.name_length);
  const cents = Number(session.metadata?.name_cents);
  if (!userId || !Number.isInteger(length) || !Number.isInteger(cents)) return null;
  return { userId, length, cents, wantedName: session.metadata?.wanted_name ?? null };
}

/** A paid invoice, as the board records it: a plan's payment. */
export interface StripeInvoice {
  id: string;
  object: "invoice";
  customer: string;
  currency: string;
  amount_paid: number;
  /** Before tax, after discounts. */
  total_excluding_tax?: number | null;
  subtotal: number;
  status_transitions?: { paid_at?: number | null } | null;
  /** The subscription it bills, since API version 2025-03-31. */
  parent?: { subscription_details?: { subscription?: string | null } | null } | null;
  /** The same, before that version. */
  subscription?: string | null;
  /** Its lines, the first page of them: a combined checkout's first invoice has the plan's and the name's. */
  lines?: {
    has_more?: boolean;
    data: Array<{
      /** Before tax and discounts. */
      amount: number;
      discount_amounts?: Array<{ amount: number }> | null;
      parent?: { type?: string | null } | null;
    }>;
  } | null;
}

/**
 * The plan's part of a paid invoice, before tax, after discounts: its
 * subscription lines. A one-time price billed with the plan, such as the
 * Short username package, is left out, so partners share the plan alone. An
 * invoice without its lines counts whole.
 */
export function planCentsOf(invoice: StripeInvoice): number {
  const whole = invoice.total_excluding_tax ?? invoice.subtotal;
  const lines = invoice.lines?.data;
  if (!lines || lines.length === 0) return whole;
  const net = (line: (typeof lines)[number]) => line.amount - (line.discount_amounts ?? []).reduce((sum, discount) => sum + discount.amount, 0);
  const other = lines.filter((line) => line.parent?.type !== "subscription_item_details").reduce((sum, line) => sum + net(line), 0);
  // Past the first page, the whole less what is known not to be the plan's.
  if (invoice.lines?.has_more) return whole - other;
  return lines.filter((line) => line.parent?.type === "subscription_item_details").reduce((sum, line) => sum + net(line), 0);
}

/** The subscription an invoice bills, or null for a one-time invoice such as a fresh start's. */
export function invoiceSubscription(invoice: StripeInvoice): string | null {
  return invoice.parent?.subscription_details?.subscription ?? invoice.subscription ?? null;
}

/** A charge, as a refund reports it: the whole refunded so far, tax included. */
export interface StripeCharge {
  id: string;
  object: "charge";
  amount: number;
  amount_refunded: number;
  payment_intent?: string | null;
}

/**
 * The invoice a payment intent paid, if any. Since API version
 * 2025-03-31 a charge no longer names its invoice; the invoice's payments
 * do.
 */
export async function invoiceOfPaymentIntent(client: StripeClient, paymentIntent: string): Promise<string | null> {
  const { data } = await client.request<{ data: Array<{ invoice: string }> }>("GET", "/invoice_payments", {
    payment: { type: "payment_intent", payment_intent: paymentIntent },
    limit: 1,
  });
  return data[0]?.invoice ?? null;
}

/**
 * What a session charged for the price with this lookup key, before tax and
 * after discounts, or null when it has no such line.
 */
export async function lineCents(client: StripeClient, sessionId: string, lookupKey: string): Promise<number | null> {
  const { data } = await client.request<{
    data: Array<{ amount_subtotal: number; amount_discount: number; price: { lookup_key: string | null } | null }>;
  }>("GET", `/checkout/sessions/${encodeURIComponent(sessionId)}/line_items`, { limit: 10 });
  const line = data.find((item) => item.price?.lookup_key === lookupKey);
  return line ? line.amount_subtotal - line.amount_discount : null;
}

export function getCheckoutSession(client: StripeClient, id: string, expand: string[] = []): Promise<StripeCheckoutSession> {
  return client.request<StripeCheckoutSession>("GET", `/checkout/sessions/${encodeURIComponent(id)}`, expand.length > 0 ? { expand } : {});
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
  /** The session itself, for a short username it paid for. */
  session: StripeCheckoutSession;
}> {
  const session = await client.request<StripeCheckoutSession & { customer: string | null; subscription: StripeSubscription | null }>(
    "GET",
    `/checkout/sessions/${encodeURIComponent(sessionId)}`,
    { expand: ["subscription"] },
  );
  return {
    userId: session.client_reference_id,
    customerId: session.customer,
    subscription: session.subscription,
    wantedName: session.metadata?.wanted_name ?? null,
    then: session.metadata?.then ?? null,
    session,
  };
}

/** A subscription as it is now, with its schedule's phases and their prices. */
export function getSubscription(client: StripeClient, id: string): Promise<StripeSubscription> {
  return client.request<StripeSubscription>("GET", `/subscriptions/${encodeURIComponent(id)}`, { expand: ["schedule.phases.items.price"] });
}

/** Marks the schedules the board makes, for anyone looking at them in Stripe. */
const SWITCH_METADATA = { aionly: "plan_switch" };

const phasePriceKey = (price: string | PhasePrice | undefined) => (price && typeof price === "object" ? price.lookup_key : null);

/**
 * The plan switch a subscription's schedule holds: the price its next phase
 * moves to, and when, if that is another price. Null for none, undefined
 * when the schedule was not read (a bare ID), so what is known stays.
 */
export function scheduledSwitch(subscription: StripeSubscription): { priceKey: string; at: number } | null | undefined {
  const schedule = subscription.schedule;
  if (!schedule) return null;
  if (typeof schedule === "string") return undefined;
  const current = subscription.items.data[0]?.price.lookup_key ?? null;
  const end = schedule.current_phase?.end_date;
  const next = schedule.phases.find((phase) => phase.start_date === end);
  const key = phasePriceKey(next?.items[0]?.price);
  return next && key && key !== current ? { priceKey: key, at: next.start_date } : null;
}

/**
 * Whether the subscription's schedule has nothing to come: in its last
 * phase, releasing the plan when it ends. The board's own once its switch
 * is made, or one it began and never set (review F114), since the board
 * alone makes schedules: letting go of it changes no billing, and leaves
 * the plan free to change or cancel in the portal again.
 */
export function scheduleIdle(subscription: StripeSubscription): boolean {
  const schedule = subscription.schedule;
  if (!schedule || typeof schedule === "string" || schedule.end_behavior !== "release") return false;
  const last = schedule.phases.at(-1);
  return last !== undefined && schedule.current_phase?.start_date === last.start_date;
}

/**
 * Whether the subscription carries an instruction the board never gives
 * and must not undo: an end set by date, or a schedule that ends other than
 * by releasing the plan, as one made in Stripe to cancel it after some
 * periods (review F119). The board's own schedules release the plan.
 */
export function arrangedInStripe(subscription: StripeSubscription): boolean {
  const schedule = subscription.schedule;
  return Boolean(subscription.cancel_at) || (typeof schedule === "object" && schedule !== null && schedule.end_behavior !== "release");
}

/** A plan switch refused because the subscription carries an instruction the board did not give (`arrangedInStripe`). */
export class ArrangedInStripe extends Error {
  constructor(subscriptionId: string) {
    super(`subscription ${subscriptionId} has an end or change arranged in Stripe`);
  }
}

/**
 * Switches the plan to `priceId` at the end of the period paid for, through
 * a schedule: this period stays as it is, nothing is charged or credited
 * now, and the new price bills from then on (owner's decision, 2026-10-20:
 * a downgrade waits for the period's end). A switch already asked for is
 * replaced; an end or change arranged in Stripe is not, and throws
 * `ArrangedInStripe`. Answers with the subscription as it is after.
 */
export async function schedulePlanSwitch(client: StripeClient, subscriptionId: string, priceId: string): Promise<StripeSubscription> {
  const subscription = await getSubscription(client, subscriptionId);
  if (arrangedInStripe(subscription)) throw new ArrangedInStripe(subscriptionId);
  const existing = subscription.schedule;
  const created = !(existing && typeof existing === "object");
  let schedule: StripeSchedule;
  if (!created) {
    schedule = existing;
  } else {
    try {
      schedule = await client.request<StripeSchedule>("POST", "/subscription_schedules", { from_subscription: subscriptionId });
    } catch (error) {
      // Made though the answer was lost: carry on with it (review F114).
      // Unread, any schedule left has nothing to come, and the webhook lets
      // go of it, as attaching it sends an event.
      const attached = (await getSubscription(client, subscriptionId).catch(() => null))?.schedule;
      if (!attached || typeof attached === "string") throw error;
      schedule = attached;
    }
  }
  const phase =
    schedule.phases.find((candidate) => candidate.start_date === schedule.current_phase?.start_date) ?? schedule.phases[0]!;
  const current = phase.items[0]!;
  const currentPrice = typeof current.price === "object" ? current.price.id : current.price;
  // The plan's discounts and tax carry on, as they would at a renewal.
  const discounts = (phase.discounts ?? []).map((discount) =>
    discount.discount ? { discount: discount.discount } : discount.promotion_code ? { promotion_code: discount.promotion_code } : { coupon: discount.coupon },
  );
  const tax = subscription.automatic_tax?.enabled ? { enabled: true } : undefined;
  try {
    await client.request("POST", `/subscription_schedules/${encodeURIComponent(schedule.id)}`, {
      end_behavior: "release",
      proration_behavior: "none",
      metadata: SWITCH_METADATA,
      phases: [
        {
          start_date: phase.start_date,
          end_date: phase.end_date,
          items: [{ price: currentPrice, quantity: current.quantity ?? 1 }],
          proration_behavior: "none",
          discounts,
          automatic_tax: tax,
        },
        { items: [{ price: priceId, quantity: 1 }], iterations: 1, proration_behavior: "none", discounts, automatic_tax: tax },
      ],
    });
  } catch (error) {
    // The phases may be set though the answer was lost: read back first.
    const after = await getSubscription(client, subscriptionId).catch(() => null);
    if (after && nextPhasePrice(after) === priceId) return after;
    // A schedule made here and left unset would bind the plan for nothing,
    // as the portal cannot change or cancel it: let go of it (review F114).
    // One that was there before is left as it was, for a retry to reuse.
    if (created) {
      await client
        .request("POST", `/subscription_schedules/${encodeURIComponent(schedule.id)}/release`)
        .catch((release: unknown) => console.error("stripe schedule left attached", schedule.id, release));
    }
    throw error;
  }
  return getSubscription(client, subscriptionId);
}

/** The price a subscription's schedule moves to when this phase ends, by its ID. */
function nextPhasePrice(subscription: StripeSubscription): string | null {
  const schedule = subscription.schedule;
  if (!schedule || typeof schedule === "string") return null;
  const next = schedule.phases.find((phase) => phase.start_date === schedule.current_phase?.end_date);
  const price = next?.items[0]?.price;
  return price === undefined ? null : typeof price === "object" ? price.id : price;
}

/**
 * The change of price that switches a plan now: the year starts today, and
 * what is left of the period paid for is credited against it, on one
 * invoice charged at once. `at` fixes that credit, so the amount quoted is
 * the amount charged.
 */
function switchNowChange(subscription: StripeSubscription, priceId: string, at: number) {
  const item = subscription.items.data[0]?.id;
  if (!item) throw new Error(`subscription ${subscription.id} came without its item`);
  return { items: [{ id: item, price: priceId }], proration_behavior: "always_invoice", proration_date: at, billing_cycle_anchor: "now" };
}

/** What switching `subscription` to `priceId` now would charge today, after any balance, and whether that includes tax. */
export async function previewSwitchNow(
  client: StripeClient,
  subscription: StripeSubscription,
  priceId: string,
  at: number,
): Promise<{ cents: number; taxed: boolean }> {
  const invoice = await client.request<{ amount_due: number; total: number; total_excluding_tax?: number | null }>("POST", "/invoices/create_preview", {
    subscription: subscription.id,
    subscription_details: switchNowChange(subscription, priceId, at),
  });
  return { cents: invoice.amount_due, taxed: invoice.total_excluding_tax != null && invoice.total > invoice.total_excluding_tax };
}

/**
 * Switches `subscription`, as just read, to `priceId` now, charging what
 * `previewSwitchNow` quotes for the same `at` (owner's decision,
 * 2026-10-20: an upgrade comes at once). The caller settles any schedule
 * first. If the charge fails, Stripe answers 402 and changes nothing.
 * Answers with the subscription as it is after.
 */
export async function switchNow(client: StripeClient, subscription: StripeSubscription, priceId: string, at: number): Promise<StripeSubscription> {
  await client.request("POST", `/subscriptions/${encodeURIComponent(subscription.id)}`, {
    ...switchNowChange(subscription, priceId, at),
    payment_behavior: "error_if_incomplete",
  });
  return getSubscription(client, subscription.id);
}

/**
 * Lets go of the schedule `scheduleId` once it has nothing to come
 * (`scheduleIdle`), judged again on a fresh read, so a switch asked for
 * since the caller's own read is kept (review F116). Answers with the
 * subscription as it is after, or null when there was nothing to let go.
 */
export async function releaseIdleSchedule(client: StripeClient, subscriptionId: string, scheduleId: string): Promise<StripeSubscription | null> {
  const fresh = await getSubscription(client, subscriptionId);
  const schedule = fresh.schedule;
  if (!schedule || typeof schedule === "string" || schedule.id !== scheduleId || !scheduleIdle(fresh)) return null;
  await client.request("POST", `/subscription_schedules/${encodeURIComponent(scheduleId)}/release`);
  return getSubscription(client, subscriptionId);
}

/**
 * Lets go of a subscription's schedule, keeping its price as it is: no
 * switch. An end or change arranged in Stripe is not let go of, and throws
 * `ArrangedInStripe`: before its last phase, a schedule's end is not yet
 * a date on the subscription for `preserve_cancel_date` to keep (review
 * F120). An end set by the time of release stays (review F119).
 */
export async function releaseSchedule(client: StripeClient, subscriptionId: string): Promise<StripeSubscription> {
  const subscription = await getSubscription(client, subscriptionId);
  if (arrangedInStripe(subscription)) throw new ArrangedInStripe(subscriptionId);
  const schedule = subscription.schedule;
  if (!schedule) return subscription;
  const id = typeof schedule === "string" ? schedule : schedule.id;
  await client.request("POST", `/subscription_schedules/${encodeURIComponent(id)}/release`, { preserve_cancel_date: true });
  return getSubscription(client, subscriptionId);
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
