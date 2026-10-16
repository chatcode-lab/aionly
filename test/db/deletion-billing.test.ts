import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelForDeletion, CheckoutBusy, checkoutUrl, freshStartCheckoutUrl } from "../../app/lib/billing/plan.server";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { deleteAccount } from "../../app/lib/db/deletion.server";
import { claimCheckout, stillHolding } from "../../app/lib/db/subscriptions.server";
import { rememberCustomer } from "../../app/lib/db/subscriptions.server";
import { FRESH_START_PRICE, PLAN_PRICES } from "../../app/lib/plan";
import { db, NOW, reset, user } from "./fixtures";

/**
 * A Stripe that completes an open checkout the moment its open checkouts
 * are listed, as a member paying in another tab would, making a
 * subscription the board has not heard of yet.
 */
function racingStripe() {
  const calls: string[] = [];
  let completed = false;
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = new URL(String(input instanceof Request ? input.url : input));
    calls.push(`${init?.method ?? "GET"} ${url.pathname}`);
    if (url.pathname === "/v1/checkout/sessions") {
      completed = true;
      return Response.json({ object: "list", data: [], has_more: false });
    }
    if (url.pathname === "/v1/subscriptions") {
      const data = completed ? [{ id: "sub_new", object: "subscription", customer: "cus_1", status: "active", items: { data: [] } }] : [];
      return Response.json({ object: "list", data, has_more: false });
    }
    if (url.pathname === "/v1/subscriptions/sub_new" && init?.method === "DELETE") {
      return Response.json({ id: "sub_new", object: "subscription", customer: "cus_1", status: "canceled", items: { data: [] } });
    }
    return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
  });
  return { calls, fetcher };
}

describe("cancelling billing before an account is deleted", () => {
  const original = env.STRIPE_SECRET_KEY;
  beforeEach(async () => {
    await reset();
    await user("member", "leaving_member");
    await rememberCustomer(db, { userId: "member", customerId: "cus_1", now: NOW });
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = "sk_test_fake";
  });
  afterEach(() => {
    (env as { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY = original;
    vi.restoreAllMocks();
  });

  it("closes open checkouts first, so one completing meanwhile is found and cancelled", async () => {
    const { calls } = racingStripe();
    await cancelForDeletion("member");
    expect(calls).toEqual(["GET /v1/checkout/sessions", "GET /v1/subscriptions", "DELETE /v1/subscriptions/sub_new"]);
  });

  it("holds off any new checkout while it runs, and refuses while one is being made", async () => {
    racingStripe();
    await cancelForDeletion("member");
    expect(await claimCheckout(db, "member", "plan", Math.floor(Date.now() / 1000))).toBeNull();
    expect(await claimCheckout(db, "member", "fresh_start", Math.floor(Date.now() / 1000))).toBeNull();

    await db.prepare(`DELETE FROM checkout_claims`).run();
    await claimCheckout(db, "member", "plan", Math.floor(Date.now() / 1000));
    await expect(cancelForDeletion("member")).rejects.toThrow();
    // Refused, it took nothing: the checkout's claim is still the only one.
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM checkout_claims`).first()).toEqual({ n: 1 });
  });

  it("keeps holding checkouts off however long Stripe takes, and lets go if the deletion stops", async () => {
    // Many old checkouts, each taking two seconds to close: over a minute in all.
    let clock = NOW;
    vi.spyOn(Date, "now").mockImplementation(() => clock * 1000);
    const admitted: boolean[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (url.pathname === "/v1/checkout/sessions") {
        const data = Array.from({ length: 31 }, (_, index) => ({ id: `cs_${index}` }));
        return Response.json({ object: "list", data, has_more: false });
      }
      if (url.pathname.endsWith("/expire") && init?.method === "POST") {
        clock += 2;
        // Another tab tries to start a checkout, as each one closes.
        admitted.push((await claimCheckout(db, "member", "plan", clock)) !== null);
        return Response.json({ id: "cs", status: "expired" });
      }
      if (url.pathname === "/v1/subscriptions") return Response.json({ object: "list", data: [], has_more: false });
      return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
    });
    const hold = await cancelForDeletion("member");
    expect(clock - NOW).toBeGreaterThan(60);
    expect(admitted).toHaveLength(31);
    expect(admitted.every((taken) => !taken)).toBe(true);
    // Still held for the deletion's own write, well past a checkout's minute.
    expect(await claimCheckout(db, "member", "fresh_start", clock + 120)).toBeNull();
    // The deletion did not go ahead: checkouts may be made again.
    await hold.release();
    expect(await claimCheckout(db, "member", "plan", clock)).not.toBeNull();
  });

  it("ends its hold in the deletion's own write", async () => {
    racingStripe();
    await cancelForDeletion("member");
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM checkout_claims WHERE user_id = 'member'`).first<{ n: number }>())!.n).toBe(2);
    await deleteAccount(db, { userId: "member", content: false, banned: false, identities: [], now: NOW });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM checkout_claims WHERE user_id = 'member'`).first()).toEqual({ n: 0 });
  });

  it.each(["plan", "fresh_start"] as const)("makes no %s checkout after the deletion for a request begun before it", async (kind) => {
    const viewer = (await accountRecord(db, "member"))!;
    let askedForPrices!: () => void;
    const asked = new Promise<void>((resolve) => (askedForPrices = resolve));
    let answerPrices!: () => void;
    const answered = new Promise<void>((resolve) => (answerPrices = resolve));
    let deleted = false;
    const afterDeletion: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = new URL(String(input instanceof Request ? input.url : input));
      if (deleted) afterDeletion.push(`${init?.method ?? "GET"} ${url.pathname}`);
      if (url.pathname === "/v1/prices") {
        // The checkout's first step, slow to answer, before it claims anything.
        askedForPrices();
        await answered;
        const data = [PLAN_PRICES.month.lookupKey, FRESH_START_PRICE.lookupKey].map((key) => ({ id: `price_${key}`, lookup_key: key }));
        return Response.json({ object: "list", data, has_more: false });
      }
      if (url.pathname === "/v1/checkout/sessions" && init?.method === "POST") return Response.json({ id: "cs_late", url: "https://checkout.example/cs_late" });
      if (url.pathname === "/v1/checkout/sessions" || url.pathname === "/v1/subscriptions") {
        return Response.json({ object: "list", data: [], has_more: false });
      }
      return Response.json({ error: { message: `unexpected ${url.pathname}` } }, { status: 404 });
    });
    const now = Math.floor(Date.now() / 1000);
    const checkout = kind === "plan" ? checkoutUrl(viewer, "month", "https://aion.ly", now) : freshStartCheckoutUrl(viewer, "https://aion.ly", now);
    const settled = checkout.then(
      (url) => ({ url }),
      (error: unknown) => ({ error }),
    );
    await asked;
    // Another tab deletes the account meanwhile, all the way.
    await cancelForDeletion("member");
    await deleteAccount(db, { userId: "member", content: false, banned: false, identities: [], now });
    deleted = true;
    answerPrices();
    const outcome = await settled;
    expect(outcome).toEqual({ error: expect.any(CheckoutBusy) });
    expect(afterDeletion.filter((call) => call.startsWith("POST"))).toEqual([]);
  });

  it("does not count a claim as held once its account is deleted", async () => {
    const claim = (await claimCheckout(db, "member", "plan", Math.floor(Date.now() / 1000)))!;
    expect(await stillHolding(db, claim, claim.at)).toBe(true);
    await db.prepare(`UPDATE profiles SET deleted_at = ?1 WHERE user_id = 'member'`).bind(NOW).run();
    expect(await stillHolding(db, claim, claim.at)).toBe(false);
  });

  it("lets go of its hold when Stripe fails, so nothing is left blocked", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ error: { message: "down" } }, { status: 500 }));
    await expect(cancelForDeletion("member")).rejects.toThrow();
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM checkout_claims`).first()).toEqual({ n: 0 });
  });
});
