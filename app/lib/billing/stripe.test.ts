import { describe, expect, it } from "vitest";

import {
  createCheckout,
  encodeForm,
  expireOpenCheckouts,
  paidFreshStart,
  periodEnd,
  runningSubscriptions,
  signWebhook,
  stripeClient,
  type StripeSubscription,
  verifyWebhook,
} from "./stripe";

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
    expect(sent!.has("metadata[wanted_name]")).toBe(false);
  });

  it("carries a new member's short name and where they were going, on the session only", async () => {
    let sent: URLSearchParams | null = null;
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent = new URLSearchParams(String(init?.body));
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_test" });
    }) as typeof fetch;
    await createCheckout(stripeClient("sk_test_unit", fetcher), {
      customerId: "cus_1",
      priceId: "price_1",
      userId: "u1",
      origin: "https://aion.ly",
      startNowAt: 1_800_000_000,
      wantedName: "nova",
      then: "/p/abc1234",
    });
    expect(sent!.get("metadata[wanted_name]")).toBe("nova");
    expect(sent!.get("metadata[then]")).toBe("/p/abc1234");
    expect(sent!.has("subscription_data[metadata][wanted_name]")).toBe(false);
  });
});

describe("one plan per member", () => {
  /** A fake Stripe that answers lists, two items a page, and records every call. */
  function fakeStripe(lists: Record<string, Array<{ id: string }>>) {
    const calls: string[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      calls.push(`${init?.method ?? "GET"} ${url.pathname}${url.search}`);
      const list = lists[url.pathname] ?? [];
      const after = url.searchParams.get("starting_after");
      const start = after ? list.findIndex((item) => item.id === after) + 1 : 0;
      return Response.json({ data: list.slice(start, start + 2), has_more: start + 2 < list.length, object: "list" });
    }) as typeof fetch;
    return { client: stripeClient("sk_test_x", fetcher), calls };
  }

  it("finds every subscription that may still charge the customer, on every page", async () => {
    const { client, calls } = fakeStripe({
      "/v1/subscriptions": [
        { id: "sub_a", status: "active" },
        { id: "sub_b", status: "canceled" },
        { id: "sub_c", status: "canceled" },
        { id: "sub_d", status: "past_due" },
      ] as Array<{ id: string; status: string }>,
    });
    expect((await runningSubscriptions(client, "cus_1")).map((subscription) => subscription.id)).toEqual(["sub_a", "sub_d"]);
    expect(calls).toEqual([
      "GET /v1/subscriptions?customer=cus_1&status=all&limit=100",
      "GET /v1/subscriptions?customer=cus_1&status=all&limit=100&starting_after=sub_b",
    ]);
  });

  it("closes checkouts left open, so only the next one can be paid, on every page", async () => {
    const { client, calls } = fakeStripe({ "/v1/checkout/sessions": [{ id: "cs_1" }, { id: "cs_2" }, { id: "cs_3" }] });
    await expireOpenCheckouts(client, "cus_1");
    expect(calls).toEqual([
      "GET /v1/checkout/sessions?customer=cus_1&status=open&limit=100",
      "GET /v1/checkout/sessions?customer=cus_1&status=open&limit=100&starting_after=cs_2",
      "POST /v1/checkout/sessions/cs_1/expire",
      "POST /v1/checkout/sessions/cs_2/expire",
      "POST /v1/checkout/sessions/cs_3/expire",
    ]);
  });

  it("refuses to answer with part of a list it could not finish", async () => {
    const many = Array.from({ length: 41 }, (_, index) => ({ id: `cs_${index}` }));
    const { client } = fakeStripe({ "/v1/checkout/sessions": many });
    await expect(expireOpenCheckouts(client, "cus_1")).rejects.toThrow(/more than/);
  });
});

describe("fresh start payments", () => {
  it("count only a paid checkout for a fresh start, for the member who started it", () => {
    const session = { id: "cs_1", object: "checkout.session" as const, mode: "payment", client_reference_id: "u1", payment_status: "paid", metadata: { kind: "fresh_start", user_id: "u1" } };
    expect(paidFreshStart(session)).toBe("u1");
    expect(paidFreshStart({ ...session, payment_status: "unpaid" })).toBeNull();
    expect(paidFreshStart({ ...session, mode: "subscription" })).toBeNull();
    expect(paidFreshStart({ ...session, metadata: {} })).toBeNull();
  });
});
