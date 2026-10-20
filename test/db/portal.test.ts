import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutUrl, handleWebhook, keepPlan, portalUrl, QUOTE_SECONDS, quoteYearly, switchPlan } from "../../app/lib/billing/plan.server";
import { signWebhook, type StripeSchedule, type StripeSubscription } from "../../app/lib/billing/stripe";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { applySubscription, claimCheckout, planStatus, releaseCheckout, rememberCustomer } from "../../app/lib/db/subscriptions.server";
import { db, NOW, reset, user } from "./fixtures";

function subscription(lookupKey: string): StripeSubscription {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    items: { data: [{ current_period_end: NOW + 30 * 86400, price: { id: "price_1", lookup_key: lookupKey, recurring: { interval: "month" } } }] },
  };
}

/** A Stripe with both portal configurations, recording the configuration each portal session asks for. */
function portalStripe() {
  const asked: Array<string | null> = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    if (url.pathname === "/v1/billing_portal/configurations") {
      const data = [
        { id: "bpc_standard", metadata: { aionly_prices: "standard" } },
        { id: "bpc_intro", metadata: { aionly_prices: "intro" } },
      ];
      return Response.json({ object: "list", data, has_more: false });
    }
    if (url.pathname === "/v1/billing_portal/sessions") {
      asked.push(new URLSearchParams(String(init?.body)).get("configuration"));
      return Response.json({ url: "https://billing.stripe.test/session" });
    }
    return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
  });
  return asked;
}

describe("the billing portal", () => {
  const original = env.STRIPE_SECRET_KEY;
  beforeEach(async () => {
    await reset();
    await user("member", "paying_member");
    await rememberCustomer(db, { userId: "member", customerId: "cus_1", now: NOW });
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake";
  });
  afterEach(() => {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = original;
    vi.restoreAllMocks();
  });

  it("keeps a plan at a new member's price among those prices, and any other among the plan's own", async () => {
    const asked = portalStripe();
    expect(await applySubscription(db, subscription("aionly_fan_monthly_intro"), { eventAt: NOW, now: NOW })).toBe(true);
    expect((await planStatus(db, "member")).priceKey).toBe("aionly_fan_monthly_intro");
    expect(await portalUrl((await accountRecord(db, "member"))!, "https://aion.ly")).toBe("https://billing.stripe.test/session");

    await applySubscription(db, subscription("aionly_fan_yearly"), { eventAt: NOW + 1, now: NOW + 1 });
    expect((await planStatus(db, "member")).priceKey).toBe("aionly_fan_yearly");
    await portalUrl((await accountRecord(db, "member"))!, "https://aion.ly");
    // The default configuration, the plan's own prices, needs no name.
    expect(asked).toEqual(["bpc_intro", null]);
  });

  it("checks out at a new member's price within three days of joining, though offered for one, and at the plan's own after", async () => {
    const asked: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/v1/prices") {
        const key = url.searchParams.getAll("lookup_keys[]")[0] ?? url.searchParams.get("lookup_keys[0]") ?? "";
        asked.push(key);
        return Response.json({ object: "list", data: [{ id: `price_${key}`, lookup_key: key }], has_more: false });
      }
      if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") return Response.json({ url: "https://checkout.stripe.test/cs" });
      if (url.pathname === "/v1/checkout/sessions" || url.pathname === "/v1/subscriptions") {
        return Response.json({ object: "list", data: [], has_more: false });
      }
      return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
    });
    const now = Math.floor(Date.now() / 1000);
    const joined = async (secondsAgo: number) => {
      await db.prepare(`UPDATE profiles SET created_at = ?1 WHERE user_id = 'member'`).bind(now - secondsAgo).run();
      await db.prepare(`DELETE FROM checkout_claims`).run();
      return (await accountRecord(db, "member"))!;
    };
    await checkoutUrl(await joined(3600), "year", "https://aion.ly", now);
    // Past the offer's day, the price holds on the plan's page for 72 hours.
    await checkoutUrl(await joined(30 * 3600), "year", "https://aion.ly", now);
    // Ten minutes' grace past those, for a page opened in time.
    await checkoutUrl(await joined(72 * 3600 + 300), "month", "https://aion.ly", now);
    await checkoutUrl(await joined(72 * 3600 + 900), "month", "https://aion.ly", now);
    expect(asked).toEqual(["aionly_fan_yearly_intro", "aionly_fan_yearly_intro", "aionly_fan_monthly_intro", "aionly_fan_monthly"]);
  });
});

describe("switching the plan: up to yearly now, down to monthly at the year's end (owner's decision, 2026-10-20)", () => {
  const original = env.STRIPE_SECRET_KEY;
  const END = NOW + 30 * 86400;
  const YEAR_END = NOW + 365 * 86400;
  beforeEach(async () => {
    await reset();
    await user("member", "paying_member");
    await rememberCustomer(db, { userId: "member", customerId: "cus_1", now: NOW });
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake";
  });
  afterEach(() => {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = original;
    vi.restoreAllMocks();
  });

  const member = async () => (await accountRecord(db, "member"))!;
  /** The amount a quote showed, as its confirmation sends it back. */
  const approve = (quote: Awaited<ReturnType<typeof quoteYearly>>) => (quote.ok ? { at: quote.at, cents: quote.cents } : { at: 0, cents: 0 });

  /**
   * A Stripe holding one subscription at `key`: it schedules or releases
   * switches, quotes and makes a switch now, or declines its card, as asked.
   * `unset` attaches a schedule begun and never set, with nothing to come.
   * Every call is recorded, with the prices looked up; `charge` sets what
   * the invoice would come to.
   */
  function switchingStripe(
    start: string,
    { refusal = null as "declined" | "confirm" | null, scheduledTo = null as string | null, unset = false } = {},
  ) {
    let key = start;
    let end = start.includes("yearly") ? YEAR_END : END;
    let next: string | null = scheduledTo;
    let bare = unset;
    let amount = 9000;
    const asked: string[] = [];
    const calls: Array<{ call: string; form: URLSearchParams }> = [];
    const current = (): StripeSubscription => ({
      ...subscription(key),
      schedule: next
        ? {
            id: "sub_sched_1",
            metadata: { aionly: "plan_switch" },
            end_behavior: "release",
            current_phase: { start_date: NOW, end_date: end },
            phases: [
              { start_date: NOW, end_date: end, items: [{ price: { id: `price_${key}`, lookup_key: key }, quantity: 1 }] },
              { start_date: end, end_date: end + 30 * 86400, items: [{ price: { id: `price_${next}`, lookup_key: next }, quantity: 1 }] },
            ],
          }
        : bare
          ? {
              id: "sub_sched_1",
              end_behavior: "release",
              current_phase: { start_date: NOW, end_date: end },
              phases: [{ start_date: NOW, end_date: end, items: [{ price: { id: `price_${key}`, lookup_key: key }, quantity: 1 }] }],
            }
          : null,
      items: {
        data: [{ id: "si_1", current_period_end: end, price: { id: `price_${key}`, lookup_key: key, recurring: { interval: key.includes("yearly") ? "year" : "month" } } }],
      },
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const form = new URLSearchParams(String(init?.body ?? ""));
      const method = init?.method ?? "GET";
      calls.push({ call: `${method} ${url.pathname}`, form });
      if (url.pathname === "/v1/prices") {
        const wanted = url.searchParams.get("lookup_keys[0]") ?? "";
        asked.push(wanted);
        return Response.json({ object: "list", data: [{ id: `price_${wanted}`, lookup_key: wanted, product: "prod_fan", unit_amount: 1 }], has_more: false });
      }
      if (url.pathname === "/v1/subscriptions/sub_1" && method === "POST") {
        if (refusal === "declined") return Response.json({ error: { type: "card_error", code: "card_declined", message: "Your card was declined." } }, { status: 402 });
        if (refusal === "confirm") {
          const message = "Payment for this subscription requires additional user action, but the requested payment behavior doesn't save the invoice or PaymentIntent.";
          return Response.json({ error: { type: "card_error", code: "subscription_payment_intent_requires_action", message } }, { status: 402 });
        }
        key = form.get("items[0][price]")!.replace(/^price_/, "");
        end = YEAR_END;
        return Response.json(current());
      }
      if (url.pathname === "/v1/subscriptions/sub_1") return Response.json(current());
      if (url.pathname === "/v1/invoices/create_preview") return Response.json({ amount_due: amount, total: amount, total_excluding_tax: 9000 });
      if (url.pathname === "/v1/subscription_schedules") {
        return Response.json({ id: "sub_sched_1", current_phase: { start_date: NOW, end_date: end }, phases: [{ start_date: NOW, end_date: end, items: [{ price: `price_${key}`, quantity: 1 }] }] });
      }
      if (url.pathname === "/v1/subscription_schedules/sub_sched_1") {
        next = form.get("phases[1][items][0][price]")!.replace(/^price_/, "");
        return Response.json({});
      }
      if (url.pathname === "/v1/subscription_schedules/sub_sched_1/release") {
        next = null;
        bare = false;
        return Response.json({});
      }
      return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
    });
    return { asked, calls, current, charge: (cents: number) => (amount = cents) };
  }

  it("switches monthly up to yearly now, charging what it quoted, the year from today", async () => {
    const stripe = switchingStripe("aionly_fan_monthly");
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    const quote = await quoteYearly(await member());
    expect(quote).toMatchObject({ ok: true, cents: 9000, taxed: false });
    const at = quote.ok ? quote.at : 0;
    const change = {
      "items[0][id]": "si_1",
      "items[0][price]": "price_aionly_fan_yearly",
      proration_behavior: "always_invoice",
      proration_date: String(at),
      billing_cycle_anchor: "now",
    };
    const preview = stripe.calls.find((call) => call.call === "POST /v1/invoices/create_preview")!;
    expect(Object.fromEntries(preview.form)).toEqual({
      subscription: "sub_1",
      "subscription_details[items][0][id]": "si_1",
      "subscription_details[items][0][price]": "price_aionly_fan_yearly",
      "subscription_details[proration_behavior]": "always_invoice",
      "subscription_details[proration_date]": String(at),
      "subscription_details[billing_cycle_anchor]": "now",
    });

    // Only at the amount just quoted.
    expect(await switchPlan(await member(), "year")).toEqual({ ok: false, reason: "stale" });
    expect(await switchPlan(await member(), "year", { at: at - QUOTE_SECONDS - 1, cents: 9000 })).toEqual({ ok: false, reason: "stale" });
    expect(stripe.calls.some((call) => call.call === "POST /v1/subscriptions/sub_1")).toBe(false);

    expect(await switchPlan(await member(), "year", approve(quote))).toEqual({ ok: true });
    const made = stripe.calls.find((call) => call.call === "POST /v1/subscriptions/sub_1")!;
    expect(Object.fromEntries(made.form)).toEqual({ ...change, payment_behavior: "error_if_incomplete" });
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_yearly", interval: "year", periodEnd: YEAR_END, nextPriceKey: null });
    expect(await switchPlan(await member(), "year", approve(quote))).toEqual({ ok: false, reason: "same" });
  });

  it("leaves the plan as it was when the card is declined", async () => {
    const stripe = switchingStripe("aionly_fan_monthly", { refusal: "declined" });
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    const quote = await quoteYearly(await member());
    expect(await switchPlan(await member(), "year", approve(quote))).toEqual({ ok: false, reason: "declined", message: "Your card was declined." });
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_monthly", periodEnd: END });
  });

  it("offers the switch at the month's end when the bank asks to confirm a payment now", async () => {
    const stripe = switchingStripe("aionly_fan_monthly", { refusal: "confirm" });
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    const quote = await quoteYearly(await member());
    expect(await switchPlan(await member(), "year", approve(quote))).toEqual({ ok: false, reason: "confirm" });
    expect((await planStatus(db, "member")).priceKey).toBe("aionly_fan_monthly");
    expect(await switchPlan(await member(), "year", "period_end")).toEqual({ ok: true });
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_monthly", nextPriceKey: "aionly_fan_yearly", nextAt: END });
  });

  it("leaves a switch waiting for the period's end to the member to undo first, whatever the card does (review F117)", async () => {
    for (const refusal of [null, "declined", "confirm"] as const) {
      vi.restoreAllMocks();
      const stripe = switchingStripe("aionly_fan_monthly", { refusal });
      await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
      const quote = await quoteYearly(await member());
      // Another tab asks for the switch at the month's end meanwhile.
      expect(await switchPlan(await member(), "year", "period_end")).toEqual({ ok: true });
      expect(await switchPlan(await member(), "year", approve(quote)), String(refusal)).toEqual({ ok: false, reason: "pending" });
      expect(stripe.calls.some((call) => call.call === "POST /v1/subscriptions/sub_1" || call.call.endsWith("/release"))).toBe(false);
      expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_monthly", nextPriceKey: "aionly_fan_yearly", nextAt: END });
      await keepPlan(await member());
    }
  });

  it("lets go of a schedule begun and never set, which holds nothing, before switching now", async () => {
    const stripe = switchingStripe("aionly_fan_monthly", { unset: true, refusal: "declined" });
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    expect((await planStatus(db, "member")).nextPriceKey).toBeNull();
    const quote = await quoteYearly(await member());
    expect(await switchPlan(await member(), "year", approve(quote))).toMatchObject({ ok: false, reason: "declined" });
    const order = stripe.calls.map((call) => call.call);
    expect(order.indexOf("POST /v1/subscription_schedules/sub_sched_1/release")).toBeLessThan(order.lastIndexOf("POST /v1/subscriptions/sub_1"));
    expect(stripe.current().schedule).toBeNull();
  });

  it("charges only the amount approved, worked out again just before, and shows a changed one to approve (review F118)", async () => {
    const stripe = switchingStripe("aionly_fan_monthly");
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    const quote = await quoteYearly(await member());
    // Tax details added in another tab since.
    stripe.charge(11070);
    const changed = await switchPlan(await member(), "year", approve(quote));
    expect(changed).toEqual({ ok: false, reason: "changed", quote: { cents: 11070, taxed: true, at: quote.ok ? quote.at : 0 } });
    expect(stripe.calls.some((call) => call.call === "POST /v1/subscriptions/sub_1")).toBe(false);
    expect((await planStatus(db, "member")).priceKey).toBe("aionly_fan_monthly");
    // Approved as it is now, it goes through.
    expect(await switchPlan(await member(), "year", { at: quote.ok ? quote.at : 0, cents: 11070 })).toEqual({ ok: true });
    expect((await planStatus(db, "member")).priceKey).toBe("aionly_fan_yearly");
  });

  it("switches yearly down to monthly from the year's end, nothing charged now, and keeps it as it is on asking", async () => {
    const stripe = switchingStripe("aionly_fan_yearly");
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    expect(await switchPlan(await member(), "month")).toEqual({ ok: true });
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_yearly", nextPriceKey: "aionly_fan_monthly", nextAt: YEAR_END });
    expect(stripe.calls.some((call) => call.call === "POST /v1/subscriptions/sub_1" || call.call === "POST /v1/invoices/create_preview")).toBe(false);
    await keepPlan(await member());
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_yearly", nextPriceKey: null, nextAt: null });
    expect(stripe.asked).toEqual(["aionly_fan_monthly"]);
  });

  it("keeps a new member's price in the switch, and asks a plan set to end to be renewed first", async () => {
    const yearly = switchingStripe("aionly_fan_yearly_intro");
    await applySubscription(db, yearly.current(), { eventAt: NOW, now: NOW });
    expect(await switchPlan(await member(), "month")).toEqual({ ok: true });
    expect(yearly.asked).toEqual(["aionly_fan_monthly_intro"]);
    await applySubscription(db, { ...yearly.current(), cancel_at_period_end: true }, { eventAt: NOW + 1, now: NOW + 1 });
    expect(await switchPlan(await member(), "month")).toEqual({ ok: false, reason: "ending" });
    expect(await quoteYearly(await member())).toEqual({ ok: false, reason: "ending" });

    vi.restoreAllMocks();
    await reset();
    await user("member", "paying_member");
    await rememberCustomer(db, { userId: "member", customerId: "cus_1", now: NOW });
    const monthly = switchingStripe("aionly_fan_monthly_intro");
    await applySubscription(db, monthly.current(), { eventAt: NOW, now: NOW });
    const quote = await quoteYearly(await member());
    expect(await switchPlan(await member(), "year", approve(quote))).toEqual({ ok: true });
    expect(monthly.asked).toEqual(["aionly_fan_yearly_intro", "aionly_fan_yearly_intro"]);
    expect((await planStatus(db, "member")).priceKey).toBe("aionly_fan_yearly_intro");
  });

  it("refuses a plan in a trial, which a switch would not keep (review F115)", async () => {
    const stripe = switchingStripe("aionly_fan_yearly");
    await applySubscription(db, { ...stripe.current(), status: "trialing" }, { eventAt: NOW, now: NOW });
    expect(await switchPlan(await member(), "month")).toEqual({ ok: false, reason: "trial" });
    expect(await quoteYearly(await member())).toEqual({ ok: false, reason: "trial" });
    expect(stripe.calls.some((call) => call.call.startsWith("POST"))).toBe(false);
  });

  it("waits while another change holds the plan", async () => {
    const stripe = switchingStripe("aionly_fan_yearly");
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    const claim = (await claimCheckout(db, "member", "plan", Math.floor(Date.now() / 1000)))!;
    expect(await switchPlan(await member(), "month")).toEqual({ ok: false, reason: "busy" });
    expect(await keepPlan(await member())).toBe(false);
    await releaseCheckout(db, claim);
    expect(await switchPlan(await member(), "month")).toEqual({ ok: true });
  });

  it("keeps the switch it knows when a subscription comes without its schedule read", async () => {
    const stripe = switchingStripe("aionly_fan_yearly");
    await applySubscription(db, stripe.current(), { eventAt: NOW, now: NOW });
    await switchPlan(await member(), "month");
    await applySubscription(db, { ...stripe.current(), schedule: "sub_sched_1" }, { eventAt: NOW + 5, now: NOW + 5 });
    expect((await planStatus(db, "member")).nextPriceKey).toBe("aionly_fan_monthly");
    await applySubscription(db, { ...stripe.current(), schedule: null }, { eventAt: NOW + 6, now: NOW + 6 });
    expect((await planStatus(db, "member")).nextPriceKey).toBeNull();
  });
});

describe("letting go of a switch once made (review F116)", () => {
  const SECRET = "whsec_test_switch";
  const vars = env as unknown as Record<string, string | undefined>;
  const saved = { secret: vars.STRIPE_WEBHOOK_SECRET, key: vars.STRIPE_SECRET_KEY };
  const START = NOW - 365 * 86400;
  beforeEach(async () => {
    await reset();
    await user("member", "paying_member");
    await rememberCustomer(db, { userId: "member", customerId: "cus_1", now: NOW });
    vars.STRIPE_WEBHOOK_SECRET = SECRET;
    vars.STRIPE_SECRET_KEY = "sk_test_fake";
  });
  afterEach(() => {
    vars.STRIPE_WEBHOOK_SECRET = saved.secret;
    vars.STRIPE_SECRET_KEY = saved.key;
    vi.restoreAllMocks();
  });

  const phase = (start: number, end: number, key: string) => ({ start_date: start, end_date: end, items: [{ price: { id: `price_${key}`, lookup_key: key }, quantity: 1 }] });
  /** Yearly, then monthly from NOW: the switch is made, the monthly phase the last. */
  const made: StripeSchedule = {
    id: "sub_sched_1",
    metadata: { aionly: "plan_switch" },
    end_behavior: "release",
    current_phase: { start_date: NOW, end_date: NOW + 30 * 86400 },
    phases: [phase(START, NOW, "aionly_fan_yearly"), phase(NOW, NOW + 30 * 86400, "aionly_fan_monthly")],
  };
  /** The same, with a switch back to yearly asked for since. */
  const asked: StripeSchedule = { ...made, phases: [...made.phases, phase(NOW + 30 * 86400, NOW + 395 * 86400, "aionly_fan_yearly")] };

  /** A Stripe whose subscription shows each schedule in turn, read after read, recording releases. */
  function stripeShowing(...schedules: Array<StripeSchedule | null>) {
    const released: string[] = [];
    let reads = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/v1/subscriptions/sub_1") {
        const schedule = released.length > 0 ? null : schedules[Math.min(reads++, schedules.length - 1)]!;
        return Response.json({ ...subscription("aionly_fan_monthly"), schedule });
      }
      if (url.pathname === "/v1/subscription_schedules/sub_sched_1/release" && init?.method === "POST") {
        released.push("sub_sched_1");
        return Response.json({});
      }
      return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
    });
    return released;
  }

  async function deliver(): Promise<Response> {
    const created = Math.floor(Date.now() / 1000);
    const payload = JSON.stringify({ type: "customer.subscription.updated", created, data: { object: subscription("aionly_fan_monthly") } });
    const signature = await signWebhook(payload, SECRET, created);
    return handleWebhook(new Request("https://aion.ly/api/stripe", { method: "POST", body: payload, headers: { "Stripe-Signature": signature } }));
  }

  it("lets go of the board's schedule once its last phase starts", async () => {
    const released = stripeShowing(made);
    expect((await deliver()).status).toBe(200);
    expect(released).toEqual(["sub_sched_1"]);
  });

  it("lets go of one begun and never set, as attaching it sends an event (review F114)", async () => {
    const unset: StripeSchedule = { id: "sub_sched_1", end_behavior: "release", current_phase: made.current_phase, phases: [made.phases[1]!] };
    const released = stripeShowing(unset);
    expect((await deliver()).status).toBe(200);
    expect(released).toEqual(["sub_sched_1"]);
    // One that would end the plan is not the board's to let go.
    vi.restoreAllMocks();
    const ending = stripeShowing({ ...unset, end_behavior: "cancel" });
    expect((await deliver()).status).toBe(200);
    expect(ending).toEqual([]);
  });

  it("keeps a switch asked for after the webhook's own read", async () => {
    const released = stripeShowing(made, asked);
    expect((await deliver()).status).toBe(200);
    expect(released).toEqual([]);
  });

  it("asks Stripe to send the event again while another change holds the plan", async () => {
    const released = stripeShowing(made);
    const claim = (await claimCheckout(db, "member", "plan", Math.floor(Date.now() / 1000)))!;
    expect((await deliver()).status).toBe(503);
    expect(released).toEqual([]);
    await releaseCheckout(db, claim);
    expect((await deliver()).status).toBe(200);
    expect(released).toEqual(["sub_sched_1"]);
  });
});
