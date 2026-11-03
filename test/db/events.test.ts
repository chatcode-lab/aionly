import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { handleWebhook } from "../../app/lib/billing/plan.server";
import { signWebhook } from "../../app/lib/billing/stripe";
import {
  announceError,
  announceSignUp,
  eventBot,
  forgetErrors,
  noticeHtml,
  redact,
} from "../../app/lib/telegram/events.server";
import { rememberCustomer } from "../../app/lib/db/subscriptions.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const SECRET = "whsec_test_events";
const TOKEN = "123456:secret-token-for-the-events-tests";
const vars = env as unknown as Record<string, string | undefined>;
const KEYS = ["STRIPE_WEBHOOK_SECRET", "STRIPE_SECRET_KEY", "TELEGRAM_BOT_TOKEN", "TELEGRAM_EVENT_GROUP_ID", "TELEGRAM_EVENT_TOPIC_ID", "SITE_ORIGIN"];
const saved = Object.fromEntries(KEYS.map((key) => [key, vars[key]]));

/** What went to Telegram. */
const sent: Array<Record<string, unknown>> = [];
let logged: ReturnType<typeof vi.spyOn>;

async function deliver(type: string, object: unknown): Promise<Response> {
  const payload = JSON.stringify({ type, created: Math.floor(Date.now() / 1000), data: { object } });
  const signature = await signWebhook(payload, SECRET, Math.floor(Date.now() / 1000));
  return handleWebhook(new Request("https://aion.ly/api/stripe", { method: "POST", body: payload, headers: { "Stripe-Signature": signature } }));
}

/** The texts sent, once the notices on their way have gone. */
async function texts(count: number): Promise<string[]> {
  await vi.waitFor(() => expect(sent.length).toBeGreaterThanOrEqual(count));
  // Anything more would come in this time.
  await new Promise((resolve) => setTimeout(resolve, 20));
  return sent.map((body) => body.text as string);
}

beforeEach(async () => {
  await reset();
  forgetErrors();
  sent.length = 0;
  Object.assign(vars, {
    STRIPE_WEBHOOK_SECRET: SECRET,
    STRIPE_SECRET_KEY: undefined,
    TELEGRAM_BOT_TOKEN: TOKEN,
    TELEGRAM_EVENT_GROUP_ID: "1234567890",
    TELEGRAM_EVENT_TOPIC_ID: "42",
    SITE_ORIGIN: "https://aion.ly",
  });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    expect(String(input)).toBe(`https://api.telegram.org/bot${TOKEN}/sendMessage`);
    sent.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
    return Response.json({ ok: true, result: { message_id: sent.length } });
  });
  logged = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  Object.assign(vars, saved);
  vi.restoreAllMocks();
});

describe("the operator's notices", () => {
  it("are written as the sample: an icon and a bold title, then a line for each value, escaped", () => {
    expect(
      noticeHtml({
        icon: "💳",
        title: "Fan plan <payment>",
        lines: [
          ["User", "<code>usr</code>"],
          ["Left out", null],
          ["", "<pre>at x</pre>"],
        ],
      }),
    ).toBe("💳 <b>Fan plan &lt;payment&gt;</b>\nUser: <code>usr</code>\n<pre>at x</pre>");
  });

  it("go to the group's topic, a supergroup's ID taken as its apps show it, and General without a topic", () => {
    expect(eventBot({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_EVENT_GROUP_ID: "1234567890", TELEGRAM_EVENT_TOPIC_ID: "42" })).toEqual({
      token: TOKEN,
      chat: "-1001234567890",
      topic: 42,
    });
    expect(eventBot({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_EVENT_GROUP_ID: "-1001234567890", TELEGRAM_EVENT_TOPIC_ID: "1" })?.topic).toBeNull();
    expect(eventBot({ TELEGRAM_BOT_TOKEN: TOKEN, TELEGRAM_EVENT_GROUP_ID: "1234567890" })?.topic).toBeNull();
    expect(eventBot({ TELEGRAM_BOT_TOKEN: TOKEN })).toBeNull();
    expect(eventBot({ TELEGRAM_EVENT_GROUP_ID: "1234567890" })).toBeNull();
  });

  it("never carry a secret", () => {
    expect(redact(`failed: https://api.telegram.org/bot${TOKEN}/sendMessage`, TOKEN)).toBe("failed: https://api.telegram.org/bot<token>/sendMessage");
    expect(redact("bot987654:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAA sk_live_abc123 whsec_xyz")).toBe("bot<token> sk_live_<hidden> whsec_<hidden>");
  });

  it("tell of a plan's payment once, however often Stripe reports it, with its interval and how far it is paid", async () => {
    await user("fan", "paying_fan", { plan: "year" });
    await db.prepare(`UPDATE subscriptions SET customer_id = 'cus_fan' WHERE user_id = 'fan'`).run();
    const invoice = {
      id: "in_1",
      object: "invoice",
      customer: "cus_fan",
      currency: "usd",
      amount_paid: 8470,
      total_excluding_tax: 7000,
      subtotal: 7000,
      status_transitions: { paid_at: NOW },
      parent: { subscription_details: { subscription: "sub_fan" } },
      lines: { has_more: false, data: [{ amount: 7000, parent: { type: "subscription_item_details" }, period: { start: NOW, end: NOW + 365 * DAY } }] },
    };
    await deliver("invoice.paid", invoice);
    await deliver("invoice.paid", invoice);
    expect(await texts(1)).toEqual([
      [
        "💳 <b>Fan plan payment</b>",
        'User: <a href="https://aion.ly/@paying_fan">@paying_fan</a> · <code>fan</code>',
        "Payment: $70.00 before tax",
        "Interval: yearly",
        "Access until: Jan 15, 2028",
        "Count: first payment",
      ].join("\n"),
    ]);
    expect(sent[0]).toMatchObject({ chat_id: "-1001234567890", message_thread_id: 42, parse_mode: "HTML", link_preview_options: { is_disabled: true } });
    // The next is counted as such.
    await deliver("invoice.paid", { ...invoice, id: "in_2" });
    expect((await texts(2))[1]).toContain("Count: 2nd payment");
  });

  it("take the interval from the invoice, not from a subscription Stripe's events have not brought up to date (review F141)", async () => {
    const line = (amount: number, days: number, proration = false) => ({
      amount,
      parent: { type: "subscription_item_details", subscription_item_details: { proration } },
      period: { start: NOW, end: NOW + days * DAY },
    });
    const invoice = (id: string, customer: string, lines: unknown[]) => ({
      id,
      object: "invoice",
      customer,
      currency: "usd",
      amount_paid: 700,
      total_excluding_tax: 700,
      subtotal: 700,
      status_transitions: { paid_at: NOW },
      parent: { subscription_details: { subscription: `sub_${id}` } },
      lines: { has_more: false, data: lines },
    });
    // The first invoice, before the subscription's own event: the board knows the customer alone.
    await user("early", "early_fan");
    await rememberCustomer(db, { userId: "early", customerId: "cus_early", now: NOW });
    await deliver("invoice.paid", invoice("in_early", "cus_early", [line(700, 31)]));
    const first = (await texts(1))[0];
    expect(first).toContain("Interval: monthly");
    expect(first).toContain("Access until: Feb 15, 2027");

    // A switch to yearly, billed before the board hears of it: the month left is credited, the year charged.
    await user("switch", "switching_fan", { plan: "year" });
    await db.prepare(`UPDATE subscriptions SET customer_id = 'cus_switch', interval = 'month' WHERE user_id = 'switch'`).run();
    await deliver("invoice.paid", { ...invoice("in_switch", "cus_switch", [line(-300, 13, true), line(7000, 365)]), amount_paid: 6700, total_excluding_tax: 6700, subtotal: 6700 });
    const second = (await texts(2))[1];
    expect(second).toContain("Payment: $67.00 before tax");
    expect(second).toContain("Interval: yearly");
    expect(second).toContain("Access until: Jan 15, 2028");
  });

  it("tell of a fresh start once, and of each refund by what it adds", async () => {
    await user("low", "low_member", { karma: -120 });
    const session = {
      id: "cs_fresh_1",
      object: "checkout.session",
      mode: "payment",
      client_reference_id: "low",
      payment_status: "paid",
      payment_intent: "pi_fresh_1",
      metadata: { kind: "fresh_start", user_id: "low" },
      amount_subtotal: 2000,
      currency: "usd",
    };
    await deliver("checkout.session.completed", session);
    await deliver("checkout.session.completed", session);
    expect(await texts(1)).toHaveLength(1);
    expect(sent[0].text).toContain("💳 <b>Fresh start payment</b>");
    expect(sent[0].text).toContain("Payment: $20.00 before tax");

    const charge = { id: "ch_1", object: "charge", amount: 2420, amount_refunded: 1000, currency: "usd", payment_intent: "pi_fresh_1" };
    await deliver("charge.refunded", charge);
    await deliver("charge.refunded", charge);
    expect(await texts(2)).toHaveLength(2);
    expect(sent[1].text).toBe(
      [
        "↩️ <b>Refund</b>",
        'User: <a href="https://aion.ly/@low_member">@low_member</a> · <code>low</code>',
        "For: Fresh start",
        "Refunded: $10.00 of $24.20, tax included",
      ].join("\n"),
    );
    // The rest, later: what it adds alone.
    await deliver("charge.refunded", { ...charge, amount_refunded: 2420 });
    expect((await texts(3))[2]).toContain("Refunded: $14.20 of $24.20");
  });

  it("send nothing where the group is not set up", async () => {
    vars.TELEGRAM_EVENT_GROUP_ID = undefined;
    await user("low", "low_member");
    announceSignUp(db, "low");
    announceError("GET /", new Error("boom"));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("tell of a new member: who, by email, and how they came", async () => {
    await user("inviter", "old_hand");
    await user("newbie", "fresh_face");
    await db.batch([
      db.prepare(
        `INSERT INTO "user" (id, name, email, "emailVerified", "createdAt", "updatedAt", "signupDigest") VALUES ('newbie', 'New', 'new@example.com', 1, 0, 0, 'daily')`,
      ),
      db.prepare(`UPDATE profiles SET invited_by = 'inviter' WHERE user_id = 'newbie'`),
    ]);
    announceSignUp(db, "newbie");
    expect(await texts(1)).toEqual([
      [
        "👤 <b>New member</b>",
        'User: <a href="https://aion.ly/@fresh_face">@fresh_face</a> · <code>newbie</code>',
        "Method: Google",
        "Email: new@example.com",
        'Joined with: an invitation from <a href="https://aion.ly/@old_hand">@old_hand</a>',
        "Digest: daily",
      ].join("\n"),
    ]);
  });

  it("tell of an error once a quarter hour, with how often it came back, and never its secrets", async () => {
    const error = new Error(`fetch failed: https://api.telegram.org/bot${TOKEN}/getMe`);
    announceError("POST /api/stripe", error, 0);
    announceError("POST /api/stripe", error, 1_000);
    announceError("POST /api/stripe", error, 2_000);
    // Somewhere else, it is another error.
    announceError("scheduled: sendDigests", error, 3_000);
    expect(await texts(2)).toHaveLength(2);
    expect(sent[0].text).toMatch(/^🚨 <b>Error<\/b>\nWhere: <code>POST \/api\/stripe<\/code>\nError: <code>Error: fetch failed: https:\/\/api\.telegram\.org\/bot&lt;token&gt;\/getMe<\/code>\n<pre>/);
    expect(JSON.stringify(sent)).not.toContain(TOKEN);
    announceError("POST /api/stripe", error, 15 * 60_000 + 1);
    expect((await texts(3))[2]).toContain("Repeats: 2 more in the quarter hour before");
  });

  it("log a refusal without the token", async () => {
    vi.mocked(fetch).mockRejectedValueOnce(new Error(`network: https://api.telegram.org/bot${TOKEN}/sendMessage`));
    announceError("GET /", new Error("boom"));
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith("event notice not sent", "Error", expect.any(String)));
    expect(JSON.stringify(logged.mock.calls)).not.toContain(TOKEN);
  });
});
