import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { handleWebhook } from "../../app/lib/billing/plan.server";
import { signWebhook } from "../../app/lib/billing/stripe";
import { applyFreshStart } from "../../app/lib/db/fresh-starts.server";
import { forgetFundStarted, fundStarted, fundSummary, giftStanding, recordGift, setShowGift } from "../../app/lib/db/fund.server";
import { recordPayment, recordRefund } from "../../app/lib/db/payments.server";
import { profileByName } from "../../app/lib/db/profiles.server";
import { db, NOW, reset, user } from "./fixtures";

const SECRET = "whsec_test_fund";
const vars = env as unknown as Record<string, string | undefined>;

/** Stripe's webhook, signed as Stripe signs it, now. */
async function deliver(type: string, object: unknown): Promise<Response> {
  const payload = JSON.stringify({ type, created: Math.floor(Date.now() / 1000), data: { object } });
  const signature = await signWebhook(payload, SECRET, Math.floor(Date.now() / 1000));
  return handleWebhook(new Request("https://aion.ly/api/stripe", { method: "POST", body: payload, headers: { "Stripe-Signature": signature } }));
}

describe("payments and the fund", () => {
  const saved = { secret: vars.STRIPE_WEBHOOK_SECRET, key: vars.STRIPE_SECRET_KEY };
  beforeEach(async () => {
    await reset();
    forgetFundStarted();
    vars.STRIPE_WEBHOOK_SECRET = SECRET;
    vars.STRIPE_SECRET_KEY = undefined;
    await user("low", "low_member", { karma: -120 });
    await user("fan", "paying_fan", { plan: "year" });
    await user("boss", "head_admin", { role: "admin" });
  });
  afterEach(() => {
    vars.STRIPE_WEBHOOK_SECRET = saved.secret;
    vars.STRIPE_SECRET_KEY = saved.key;
  });

  it("records a paid fresh start once, before tax, however often Stripe reports it", async () => {
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
    expect((await deliver("checkout.session.completed", session)).status).toBe(200);
    expect((await deliver("checkout.session.completed", session)).status).toBe(200);
    const rows = await db.prepare(`SELECT id, user_id, kind, amount_cents, payment_intent FROM payments`).all();
    expect(rows.results).toEqual([{ id: "cs_fresh_1", user_id: "low", kind: "fresh_start", amount_cents: 2000, payment_intent: "pi_fresh_1" }]);
    expect(await fundStarted(db)).toBe(true);
    const fund = await fundSummary(db);
    expect(fund).toMatchObject({ collectedCents: 2000, freshStarts: 1, givenCents: 0, givers: [] });
    expect(fund.months).toHaveLength(1);
  });

  it("records a plan's paid invoice for the customer's member, and a refund against it", async () => {
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
    };
    await deliver("invoice.paid", invoice);
    // Nothing paid, nothing recorded; an unknown customer is left out.
    await deliver("invoice.paid", { ...invoice, id: "in_2", amount_paid: 0 });
    await deliver("invoice.paid", { ...invoice, id: "in_3", customer: "cus_nobody" });
    expect((await db.prepare(`SELECT id, user_id, kind, amount_cents, paid_at FROM payments`).all()).results).toEqual([
      { id: "in_1", user_id: "fan", kind: "plan", amount_cents: 7000, paid_at: NOW },
    ]);
    // A refund by its payment intent: half of what was paid, tax included, so half before tax.
    await recordPayment(db, { id: "in_1", userId: "fan", kind: "plan", amountCents: 7000, currency: "usd", paidAt: NOW, paymentIntent: "pi_plan" });
    await deliver("charge.refunded", { id: "ch_1", object: "charge", amount: 8470, amount_refunded: 4235, payment_intent: "pi_plan" });
    expect(await db.prepare(`SELECT refunded_cents FROM payments WHERE id = 'in_1'`).first()).toEqual({ refunded_cents: 3500 });
    expect(await recordRefund(db, { paymentIntent: "pi_unknown", refunded: 1, paid: 2 })).toBe(false);
  });

  it("is empty until a fresh start is paid, and counts neither an admin's grant nor a refunded one", async () => {
    expect(await fundStarted(db)).toBe(false);
    await applyFreshStart(db, { id: "act_1", userId: "low", source: "admin", now: NOW });
    await recordPayment(db, { id: "cs_2", userId: "low", kind: "fresh_start", amountCents: 2000, currency: "usd", paidAt: NOW });
    await recordRefund(db, { id: "cs_2", paymentIntent: "pi_2", refunded: 2400, paid: 2400 });
    forgetFundStarted();
    expect(await fundStarted(db)).toBe(false);
    expect(await fundSummary(db)).toMatchObject({ collectedCents: 0 });
  });

  it("lists gifts, and shows a member's gift on their profile only when they choose", async () => {
    await recordPayment(db, { id: "cs_3", userId: "low", kind: "fresh_start", amountCents: 2000, currency: "usd", paidAt: NOW });
    await recordGift(db, {
      givenOn: "2026-10-31",
      amountCents: 1850,
      recipient: "A cause",
      recipientUrl: "https://cause.example/",
      receiptUrl: null,
      note: null,
      actorId: "boss",
      now: NOW,
    });
    const hidden = await profileByName(db, "low_member");
    expect(hidden?.kind === "profile" && hidden.profile.giftCents).toBeFalsy();
    expect(await giftStanding(db, "low")).toEqual({ gaveCents: 2000, shown: false });
    await setShowGift(db, "low", true);
    const shown = await profileByName(db, "low_member");
    expect(shown?.kind === "profile" && shown.profile.giftCents).toBe(2000);
    const fund = await fundSummary(db);
    expect(fund).toMatchObject({ collectedCents: 2000, givenCents: 1850, givers: ["low_member"] });
    expect(fund.gifts.map((gift) => [gift.givenOn, gift.amountCents, gift.recipient])).toEqual([["2026-10-31", 1850, "A cause"]]);
  });
});
