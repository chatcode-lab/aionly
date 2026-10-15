import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { cancelForDeletion } from "../../app/lib/billing/plan.server";
import { claimCheckout } from "../../app/lib/db/subscriptions.server";
import { rememberCustomer } from "../../app/lib/db/subscriptions.server";
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
  });
});
