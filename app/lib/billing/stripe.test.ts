import { describe, expect, it } from "vitest";

import { createCheckout, encodeForm, periodEnd, signWebhook, stripeClient, type StripeSubscription, verifyWebhook } from "./stripe";

const SECRET = "whsec_test_secret";
const NOW = 1_800_000_000;

describe("Stripe's form encoding", () => {
  it("nests objects and lists the way Stripe reads them", () => {
    const form = encodeForm({
      mode: "subscription",
      line_items: [{ price: "price_1", quantity: 1 }],
      automatic_tax: { enabled: true },
      skipped: undefined,
    });
    expect([...form]).toEqual([
      ["mode", "subscription"],
      ["line_items[0][price]", "price_1"],
      ["line_items[0][quantity]", "1"],
      ["automatic_tax[enabled]", "true"],
    ]);
  });
});

describe("webhook signatures", () => {
  const payload = JSON.stringify({ type: "customer.subscription.updated" });

  it("accepts Stripe's signature and refuses anything else", async () => {
    const header = await signWebhook(payload, SECRET, NOW);
    expect(await verifyWebhook(payload, header, SECRET, NOW + 10)).toBe(true);
    expect(await verifyWebhook(`${payload} `, header, SECRET, NOW)).toBe(false);
    expect(await verifyWebhook(payload, header, "whsec_other", NOW)).toBe(false);
    expect(await verifyWebhook(payload, null, SECRET, NOW)).toBe(false);
    expect(await verifyWebhook(payload, header, "", NOW)).toBe(false);
  });

  it("refuses an old signature, so a captured request cannot be replayed", async () => {
    const header = await signWebhook(payload, SECRET, NOW - 301);
    expect(await verifyWebhook(payload, header, SECRET, NOW)).toBe(false);
  });

  it("accepts any of several signatures, as during a secret's rotation", async () => {
    const good = (await signWebhook(payload, SECRET, NOW)).split(",")[1];
    expect(await verifyWebhook(payload, `t=${NOW},v1=deadbeef,${good}`, SECRET, NOW)).toBe(true);
  });
});

describe("the period", () => {
  it("is read from the item in newer API versions, and the subscription in older ones", () => {
    const base = { id: "sub", object: "subscription", customer: "cus", status: "active", cancel_at_period_end: false } as const;
    const item = (end?: number) => ({ current_period_end: end, price: { id: "p", lookup_key: null, recurring: { interval: "month" } } });
    expect(periodEnd({ ...base, items: { data: [item(NOW)] } } as StripeSubscription)).toBe(NOW);
    expect(periodEnd({ ...base, current_period_end: NOW + 1, items: { data: [item()] } } as StripeSubscription)).toBe(NOW + 1);
  });
});

describe("checkout", () => {
  it("records the member's request to start at once, with the session and the subscription", async () => {
    let sent: URLSearchParams | null = null;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test" });
    }) as typeof fetch;
    const url = await createCheckout(stripeClient("sk_test_unit", fetcher), {
      customerId: "cus_1",
      priceId: "price_1",
      userId: "u1",
      origin: "https://aion.ly",
      startNowAt: 1_800_000_000,
    });
    expect(url).toBe("https://checkout.stripe.com/c/pay/cs_test");
    expect(sent!.get("metadata[start_now_requested_at]")).toBe("1800000000");
    expect(sent!.get("subscription_data[metadata][start_now_requested_at]")).toBe("1800000000");
    expect(sent!.get("subscription_data[metadata][user_id]")).toBe("u1");
  });
});
