import { describe, expect, it } from "vitest";

import {
  completedNameCheckouts,
  createCheckout,
  createFreshStartCheckout,
  createNameCheckout,
  encodeForm,
  expireOpenCheckouts,
  paidFreshStart,
  paidNameAllowance,
  periodEnd,
  planCentsOf,
  type StripeInvoice,
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

describe("the 4-letter username", () => {
  const capture = () => {
    const sent: { form: URLSearchParams | null } = { form: null };
    const fetcher = (async (_url: string, init?: RequestInit) => {
      sent.form = new URLSearchParams(String(init?.body));
      return Response.json({ url: "https://checkout.stripe.com/c/pay/cs_name" });
    }) as typeof fetch;
    return { sent, client: stripeClient("sk_test_unit", fetcher) };
  };
  const input = {
    customerId: "cus_1",
    namePriceId: "price_name",
    nameCents: 25000,
    length: 4,
    userId: "u1",
    origin: "https://aion.ly",
    startNowAt: NOW,
    wantedName: "nova",
  };

  it("is one payment alone, carrying the name and the request to have it at once", async () => {
    const { sent, client } = capture();
    await createNameCheckout(client, { ...input, planPriceId: null });
    const fields = Object.fromEntries([...sent.form!]);
    expect(fields).toMatchObject({
      mode: "payment",
      "line_items[0][price]": "price_name",
      "metadata[kind]": "name_allowance",
      "metadata[name_length]": "4",
      "metadata[name_cents]": "25000",
      "metadata[wanted_name]": "nova",
      "metadata[start_now_requested_at]": String(NOW),
      "invoice_creation[enabled]": "true",
      cancel_url: "https://aion.ly/fan?name=nova",
    });
    // Promotion codes are taken, so a code can give the name away.
    expect(fields.allow_promotion_codes).toBe("true");
  });

  it("rides on the plan's checkout when bought with it, on the first invoice", async () => {
    const { sent, client } = capture();
    await createNameCheckout(client, { ...input, planPriceId: "price_year" });
    const fields = Object.fromEntries([...sent.form!]);
    expect(fields).toMatchObject({
      mode: "subscription",
      "line_items[0][price]": "price_year",
      "line_items[1][price]": "price_name",
      "subscription_data[metadata][user_id]": "u1",
      "metadata[kind]": "name_allowance",
      allow_promotion_codes: "true",
    });
    expect(sent.form!.has("subscription_data[metadata][kind]")).toBe(false);
  });

  it("is given only once paid, to the account that started it", () => {
    const session = {
      id: "cs_1",
      object: "checkout.session" as const,
      mode: "payment",
      client_reference_id: "u1",
      payment_status: "paid",
      metadata: { kind: "name_allowance", name_length: "4", name_cents: "25000", wanted_name: "nova" },
    };
    expect(paidNameAllowance(session)).toEqual({ userId: "u1", length: 4, cents: 25000, wantedName: "nova" });
    expect(paidNameAllowance({ ...session, payment_status: "unpaid" })).toBeNull();
    // A code for all of it leaves nothing to pay.
    expect(paidNameAllowance({ ...session, payment_status: "no_payment_required" })).toMatchObject({ userId: "u1", length: 4 });
    expect(paidNameAllowance({ ...session, metadata: { kind: "fresh_start" } })).toBeNull();
  });

  it("is found among the customer's completed checkouts, paid, still being paid, or failed, a bundle by its first invoice (reviews F81, F84)", async () => {
    const name = { kind: "name_allowance", name_length: "4", name_cents: "25000" };
    const fetcher = (async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      expect(url.searchParams.get("status")).toBe("complete");
      expect(url.searchParams.getAll("expand[0]")).toEqual(["data.payment_intent"]);
      return Response.json({
        data: [
          { id: "cs_plan", mode: "subscription", payment_status: "paid", metadata: { user_id: "u1" } },
          { id: "cs_paid", mode: "payment", client_reference_id: "u1", payment_status: "paid", metadata: name, payment_intent: { id: "pi_1", status: "succeeded" } },
          { id: "cs_slow", mode: "payment", payment_status: "unpaid", metadata: name, payment_intent: { id: "pi_2", status: "processing" } },
          { id: "cs_failed", mode: "payment", payment_status: "unpaid", metadata: name, payment_intent: { id: "pi_3", status: "requires_payment_method" } },
          { id: "cs_bundle", mode: "subscription", payment_status: "unpaid", metadata: name, subscription: { id: "sub_1", status: "incomplete_expired" } },
          // A delayed first payment that failed: its invoice voided, the subscription still active.
          {
            id: "cs_voided",
            mode: "subscription",
            payment_status: "unpaid",
            metadata: name,
            subscription: { id: "sub_2", status: "active" },
            invoice: { id: "in_2", status: "void" },
          },
          {
            id: "cs_waiting",
            mode: "subscription",
            payment_status: "unpaid",
            metadata: name,
            subscription: { id: "sub_3", status: "incomplete" },
            invoice: { id: "in_3", status: "open" },
          },
        ],
        has_more: false,
      });
    }) as typeof fetch;
    const found = await completedNameCheckouts(stripeClient("sk_test_unit", fetcher), "cus_1");
    expect(found.map((item) => [item.session.id, item.state])).toEqual([
      ["cs_paid", "paid"],
      ["cs_slow", "pending"],
      ["cs_failed", "failed"],
      ["cs_bundle", "failed"],
      ["cs_voided", "failed"],
      ["cs_waiting", "pending"],
    ]);
    // The payment intent comes back as its ID, as the rest of the board reads it.
    expect(found[0]!.session.payment_intent).toBe("pi_1");
  });

  it("is left out of the plan's part of an invoice, which partners share", () => {
    const base: StripeInvoice = { id: "in_1", object: "invoice", customer: "cus_1", currency: "usd", amount_paid: 1, total_excluding_tax: 35000, subtotal: 35000 };
    const line = (amount: number, type: string, discount = 0) => ({ amount, discount_amounts: [{ amount: discount }], parent: { type } });
    expect(planCentsOf(base)).toBe(35000);
    expect(planCentsOf({ ...base, lines: { data: [line(25000, "invoice_item_details"), line(10000, "subscription_item_details", 1000)] } })).toBe(9000);
    // Past the first page of lines, the whole less what is known not to be the plan's.
    expect(planCentsOf({ ...base, lines: { has_more: true, data: [line(25000, "invoice_item_details")] } })).toBe(10000);
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

  it("charge the amount the member chose, on the fresh start's product, with tax on top", async () => {
    let form: URLSearchParams | null = null;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      form = init?.body as URLSearchParams;
      return Response.json({ url: "https://checkout.stripe.com/c/pay/x" });
    }) as typeof fetch;
    const client = stripeClient("sk_test_x", fetcher);
    await createFreshStartCheckout(client, { customerId: "cus_1", productId: "prod_fresh", amountCents: 5000, userId: "u1", origin: "https://aion.ly", startNowAt: NOW });
    const fields = Object.fromEntries([...form!]);
    expect(fields).toMatchObject({
      "line_items[0][price_data][currency]": "usd",
      "line_items[0][price_data][product]": "prod_fresh",
      "line_items[0][price_data][unit_amount]": "5000",
      "line_items[0][price_data][tax_behavior]": "exclusive",
      "line_items[0][quantity]": "1",
      "automatic_tax[enabled]": "true",
      "metadata[kind]": "fresh_start",
    });
  });
});
