import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { checkoutUrl, portalUrl } from "../../app/lib/billing/plan.server";
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
