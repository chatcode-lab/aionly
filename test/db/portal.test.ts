import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutUrl, keepPlan, portalUrl, switchPlan } from "../../app/lib/billing/plan.server";
import type { StripeSubscription } from "../../app/lib/billing/stripe";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { applySubscription, planStatus, rememberCustomer } from "../../app/lib/db/subscriptions.server";
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

describe("switching the plan at the period's end (owner's decision, 2026-10-20)", () => {
  const original = env.STRIPE_SECRET_KEY;
  const END = NOW + 30 * 86400;
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

  /** A Stripe holding the subscription, scheduling or releasing switches as asked; the prices asked for are recorded. */
  function switchingStripe(key: string) {
    const asked: string[] = [];
    let next: { id: string; key: string } | null = null;
    const current = () => ({
      ...subscription(key),
      schedule: next
        ? {
            id: "sub_sched_1",
            metadata: { aionly: "plan_switch" },
            current_phase: { start_date: NOW, end_date: END },
            phases: [
              { start_date: NOW, end_date: END, items: [{ price: { id: "price_1", lookup_key: key }, quantity: 1 }] },
              { start_date: END, end_date: END + 365 * 86400, items: [{ price: { id: next.id, lookup_key: next.key }, quantity: 1 }] },
            ],
          }
        : null,
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      const form = new URLSearchParams(String(init?.body ?? ""));
      if (url.pathname === "/v1/prices") {
        const wanted = url.searchParams.get("lookup_keys[0]") ?? "";
        asked.push(wanted);
        return Response.json({ object: "list", data: [{ id: `price_${wanted}`, lookup_key: wanted, product: "prod_fan", unit_amount: 1 }], has_more: false });
      }
      if (url.pathname === "/v1/subscriptions/sub_1") return Response.json(current());
      if (url.pathname === "/v1/subscription_schedules") {
        return Response.json({ id: "sub_sched_1", current_phase: { start_date: NOW, end_date: END }, phases: [current().schedule?.phases[0] ?? { start_date: NOW, end_date: END, items: [{ price: "price_1", quantity: 1 }] }] });
      }
      if (url.pathname === "/v1/subscription_schedules/sub_sched_1") {
        const price = form.get("phases[1][items][0][price]")!;
        next = { id: price, key: price.replace(/^price_/, "") };
        return Response.json({});
      }
      if (url.pathname === "/v1/subscription_schedules/sub_sched_1/release") {
        next = null;
        return Response.json({});
      }
      return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
    });
    return asked;
  }

  it("switches monthly to yearly, or back, from the period's end, and keeps it as it is on asking", async () => {
    const asked = switchingStripe("aionly_fan_monthly");
    await applySubscription(db, subscription("aionly_fan_monthly"), { eventAt: NOW, now: NOW });
    const member = async () => (await accountRecord(db, "member"))!;
    expect(await switchPlan(await member(), "month")).toEqual({ ok: false, reason: "same" });
    expect(await switchPlan(await member(), "year")).toEqual({ ok: true });
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_monthly", nextPriceKey: "aionly_fan_yearly", nextAt: END });
    await keepPlan(await member());
    expect(await planStatus(db, "member")).toMatchObject({ priceKey: "aionly_fan_monthly", nextPriceKey: null, nextAt: null });
    expect(asked).toEqual(["aionly_fan_yearly"]);
  });

  it("keeps a new member's price in the switch, and asks a plan set to end to be renewed first", async () => {
    const asked = switchingStripe("aionly_fan_yearly_intro");
    await applySubscription(db, { ...subscription("aionly_fan_yearly_intro"), items: { data: [{ current_period_end: END, price: { id: "price_1", lookup_key: "aionly_fan_yearly_intro", recurring: { interval: "year" } } }] } }, { eventAt: NOW, now: NOW });
    expect(await switchPlan((await accountRecord(db, "member"))!, "month")).toEqual({ ok: true });
    expect(asked).toEqual(["aionly_fan_monthly_intro"]);
    await applySubscription(db, { ...subscription("aionly_fan_yearly_intro"), cancel_at_period_end: true }, { eventAt: NOW + 1, now: NOW + 1 });
    expect(await switchPlan((await accountRecord(db, "member"))!, "month")).toEqual({ ok: false, reason: "ending" });
  });

  it("keeps the switch it knows when a subscription comes without its schedule read", async () => {
    switchingStripe("aionly_fan_monthly");
    await applySubscription(db, subscription("aionly_fan_monthly"), { eventAt: NOW, now: NOW });
    await switchPlan((await accountRecord(db, "member"))!, "year");
    await applySubscription(db, { ...subscription("aionly_fan_monthly"), schedule: "sub_sched_1" }, { eventAt: NOW + 5, now: NOW + 5 });
    expect((await planStatus(db, "member")).nextPriceKey).toBe("aionly_fan_yearly");
    await applySubscription(db, { ...subscription("aionly_fan_monthly"), schedule: null }, { eventAt: NOW + 6, now: NOW + 6 });
    expect((await planStatus(db, "member")).nextPriceKey).toBeNull();
  });
});
