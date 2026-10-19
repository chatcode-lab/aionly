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
      parent: { subscription_details: { subscription: "sub_fan" } },
    };
    await deliver("invoice.paid", invoice);
    // A one-time invoice, as a fresh start's checkout makes, is never the plan's (F65).
    await deliver("invoice.paid", { ...invoice, id: "in_fresh", parent: null, amount_paid: 2400, total_excluding_tax: 2000, subtotal: 2000 });
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
    // An older snapshot of the same charge, arriving late, lowers nothing (F66).
    await deliver("charge.refunded", { id: "ch_1", object: "charge", amount: 8470, amount_refunded: 1000, payment_intent: "pi_plan" });
    expect(await db.prepare(`SELECT refunded_cents FROM payments WHERE id = 'in_1'`).first()).toEqual({ refunded_cents: 3500 });
  });

  it("counts only the plan's lines of an invoice that also bills the 4-letter username, and gives the plan's invitations once", async () => {
    await db.prepare(`UPDATE subscriptions SET customer_id = 'cus_fan' WHERE user_id = 'fan'`).run();
    const line = (amount: number, type: string, discount = 0) => ({
      amount,
      discount_amounts: discount ? [{ amount: discount }] : [],
      parent: { type },
    });
    await deliver("invoice.paid", {
      id: "in_both",
      object: "invoice",
      customer: "cus_fan",
      currency: "usd",
      amount_paid: 38720,
      total_excluding_tax: 32000,
      subtotal: 32000,
      status_transitions: { paid_at: NOW },
      parent: { subscription_details: { subscription: "sub_fan" } },
      lines: { has_more: false, data: [line(25000, "invoice_item_details"), line(10000, "subscription_item_details", 3000)] },
    });
    expect((await db.prepare(`SELECT id, kind, amount_cents FROM payments`).all()).results).toEqual([{ id: "in_both", kind: "plan", amount_cents: 7000 }]);
    expect(await db.prepare(`SELECT paid_invites, paid_invites_at FROM profiles WHERE user_id = 'fan'`).first()).toEqual({
      paid_invites: 5,
      paid_invites_at: NOW + 14 * 86400,
    });
    // The name itself, from the completed checkout: alone or with the plan.
    const session = {
      id: "cs_name",
      object: "checkout.session",
      mode: "subscription",
      client_reference_id: "fan",
      payment_status: "paid",
      payment_intent: null,
      metadata: { kind: "name_allowance", user_id: "fan", name_length: "4", name_cents: "25000", wanted_name: "nova" },
      currency: "usd",
    };
    await deliver("checkout.session.completed", { ...session, payment_status: "unpaid" });
    expect(await db.prepare(`SELECT name_allowance FROM profiles WHERE user_id = 'fan'`).first()).toEqual({ name_allowance: null });
    await deliver("checkout.session.completed", session);
    await deliver("checkout.session.completed", session);
    expect(await db.prepare(`SELECT name_allowance FROM profiles WHERE user_id = 'fan'`).first()).toEqual({ name_allowance: 4 });
    expect((await db.prepare(`SELECT id, kind, amount_cents FROM payments WHERE kind = 'name'`).all()).results).toEqual([
      { id: "cs_name", kind: "name", amount_cents: 25000 },
    ]);
    // Given away with a promotion code for all of it: nothing to pay, nothing earned.
    await deliver("checkout.session.completed", {
      ...session,
      id: "cs_gift",
      mode: "payment",
      client_reference_id: "low",
      payment_status: "no_payment_required",
      metadata: { ...session.metadata, user_id: "low" },
      amount_subtotal: 25000,
      total_details: { amount_discount: 25000 },
    });
    expect(await db.prepare(`SELECT name_allowance FROM profiles WHERE user_id = 'low'`).first()).toEqual({ name_allowance: 4 });
    expect(await db.prepare(`SELECT amount_cents FROM payments WHERE id = 'cs_gift'`).first()).toEqual({ amount_cents: 0 });
  });

  it("keeps a refund that comes before its payment, and applies it when the payment comes (F66)", async () => {
    // A full refund of a fresh start, reported before its checkout is recorded.
    await recordRefund(db, { chargeId: "ch_early", paymentIntent: "pi_early", refunded: 2400, paid: 2400, now: NOW });
    await recordPayment(db, { id: "cs_early", userId: "low", kind: "fresh_start", amountCents: 2000, currency: "usd", paidAt: NOW, paymentIntent: "pi_early" });
    expect(await db.prepare(`SELECT refunded_cents FROM payments WHERE id = 'cs_early'`).first()).toEqual({ refunded_cents: 2000 });
    // An invoice's refund, which Stripe names by invoice, before the invoice is recorded.
    await recordRefund(db, { chargeId: "ch_inv", paymentIntent: "pi_inv", invoiceId: "in_late", refunded: 4235, paid: 8470, now: NOW });
    await recordPayment(db, { id: "in_late", userId: "fan", kind: "plan", amountCents: 7000, currency: "usd", paidAt: NOW });
    expect(await db.prepare(`SELECT refunded_cents, payment_intent FROM payments WHERE id = 'in_late'`).first()).toEqual({
      refunded_cents: 3500,
      payment_intent: null,
    });
  });

  it("is empty until a fresh start is paid, and counts neither an admin's grant nor a refunded one", async () => {
    expect(await fundStarted(db)).toBe(false);
    await applyFreshStart(db, { id: "act_1", userId: "low", source: "admin", now: NOW });
    await recordPayment(db, { id: "cs_2", userId: "low", kind: "fresh_start", amountCents: 2000, currency: "usd", paidAt: NOW });
    await recordRefund(db, { chargeId: "ch_2", invoiceId: "cs_2", paymentIntent: "pi_2", refunded: 2400, paid: 2400, now: NOW });
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
