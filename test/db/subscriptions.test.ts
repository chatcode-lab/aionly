import { beforeEach, describe, expect, it } from "vitest";

import type { StripeSubscription } from "../../app/lib/billing/stripe";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { createAgent } from "../../app/lib/db/agents.server";
import { postPage } from "../../app/lib/db/posts.server";
import {
  applySubscription,
  claimCheckout,
  PLAN_GRACE_SECONDS,
  releaseCheckout,
  rememberCustomer,
  setShowMark,
  stillHolding,
} from "../../app/lib/db/subscriptions.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

const END = NOW + 30 * DAY;

function subscription(fields: Partial<StripeSubscription> & { end?: number; interval?: string } = {}): StripeSubscription {
  return {
    id: "sub_1",
    object: "subscription",
    customer: "cus_1",
    status: "active",
    cancel_at_period_end: false,
    ...fields,
    items: {
      data: [{ current_period_end: fields.end ?? END, price: { id: "price_1", lookup_key: "aionly_supporter_monthly", recurring: { interval: fields.interval ?? "month" } } }],
    },
  };
}

const planUntil = async (id: string) =>
  (await db.prepare(`SELECT plan_until FROM profiles WHERE user_id = ?1`).bind(id).first<{ plan_until: number | null }>())!.plan_until;

beforeEach(async () => {
  await reset();
  await db.prepare(`DELETE FROM subscriptions`).run();
  await user("member", "quiet_otter");
  await rememberCustomer(db, { userId: "member", customerId: "cus_1", now: NOW });
});

describe("the Supporter plan from Stripe", () => {
  it("is in force through the paid period and a short grace, for the member and their agent", async () => {
    expect(await applySubscription(db, subscription(), { eventAt: NOW, now: NOW })).toBe(true);
    expect(await planUntil("member")).toBe(END + PLAN_GRACE_SECONDS);
    const record = await accountRecord(db, "member", NOW);
    expect(record).toMatchObject({ supporter: true, entitled: true, showMark: true });
    expect((await accountRecord(db, "member", END + PLAN_GRACE_SECONDS))?.entitled).toBe(false);

    const made = await createAgent(db, { ownerId: "member", ownerName: "quiet_otter", now: NOW });
    const agent = await accountRecord(db, made.ok ? made.agent.id : "", NOW);
    expect(agent).toMatchObject({ entitled: true, supporter: false });
  });

  it("ends at once when the subscription is cancelled or unpaid", async () => {
    await applySubscription(db, subscription(), { eventAt: NOW, now: NOW });
    await applySubscription(db, subscription({ status: "canceled" }), { eventAt: NOW + 60, now: NOW + 60 });
    expect(await planUntil("member")).toBe(NOW + 60);
    expect((await accountRecord(db, "member", NOW + 61))?.entitled).toBe(false);
  });

  it("never stretches an ended plan when its end is heard again later", async () => {
    await applySubscription(db, subscription(), { eventAt: NOW, now: NOW });
    await applySubscription(db, subscription({ status: "canceled" }), { eventAt: NOW + 60, now: NOW + 60 });
    await applySubscription(db, subscription({ status: "canceled" }), { eventAt: NOW + 60, now: NOW + 3600 });
    expect(await planUntil("member")).toBe(NOW + 60);
  });

  it("ignores a state older than the one applied", async () => {
    await applySubscription(db, subscription({ status: "canceled" }), { eventAt: NOW + 60, now: NOW + 60 });
    await applySubscription(db, subscription(), { eventAt: NOW, now: NOW + 61 });
    expect(await planUntil("member")).toBe(NOW + 60);
  });

  it("never revives an ended subscription, even from an earlier read applied late in the same second", async () => {
    await applySubscription(db, subscription(), { eventAt: NOW, now: NOW });
    await applySubscription(db, subscription({ status: "canceled" }), { eventAt: NOW + 5, now: NOW + 5 });
    // The active read, fetched first but applied last, for an event in the same second.
    await applySubscription(db, subscription(), { eventAt: NOW + 5, now: NOW + 6 });
    expect(await db.prepare(`SELECT status FROM subscriptions WHERE user_id = 'member'`).first()).toEqual({ status: "canceled" });
    expect(await planUntil("member")).toBe(NOW + 5);
  });

  it("never lets a late word about an old subscription displace one in force", async () => {
    await applySubscription(db, subscription({ id: "sub_new" }), { eventAt: NOW, now: NOW });
    await applySubscription(db, subscription({ id: "sub_old", status: "canceled" }), { eventAt: NOW + 60, now: NOW + 60 });
    expect(await planUntil("member")).toBe(END + PLAN_GRACE_SECONDS);
  });

  it("finds the member by the subscription's metadata when the customer is new to the board", async () => {
    await user("other", "paper_lark");
    const made = subscription({ customer: "cus_2", metadata: { user_id: "other" } });
    expect(await applySubscription(db, made, { eventAt: NOW, now: NOW })).toBe(true);
    expect(await planUntil("other")).toBe(END + PLAN_GRACE_SECONDS);
    expect(await applySubscription(db, subscription({ customer: "cus_3" }), { eventAt: NOW, now: NOW })).toBe(false);
  });

  it("shows the Supporter mark on what they write, unless they hide it", async () => {
    await applySubscription(db, subscription(), { eventAt: NOW, now: NOW });
    await post("p1", { author: "member" });
    const author = async () => {
      const page = await postPage(db, "p1");
      return page?.state === "live" ? page.post.author : null;
    };
    expect(await author()).toMatchObject({ supporter: true, outsideLinks: true });
    await setShowMark(db, "member", false);
    expect((await author())?.supporter).toBeUndefined();
    expect((await author())?.outsideLinks).toBe(true);
  });
});

describe("making a checkout", () => {
  it("is held for one request at a time per member and kind, and a dead claim lapses", async () => {
    const first = await claimCheckout(db, "u1", "plan", NOW);
    expect(first).not.toBeNull();
    // Another tab, at the same moment: held off.
    expect(await claimCheckout(db, "u1", "plan", NOW)).toBeNull();
    expect(await claimCheckout(db, "u1", "fresh_start", NOW)).not.toBeNull();
    expect(await claimCheckout(db, "u2", "plan", NOW)).not.toBeNull();
    await releaseCheckout(db, first!);
    const second = await claimCheckout(db, "u1", "plan", NOW + 1);
    expect(second).not.toBeNull();
    expect(await claimCheckout(db, "u1", "plan", NOW + 30)).toBeNull();
    // A claim whose request died is taken over after a minute.
    expect(await claimCheckout(db, "u1", "plan", NOW + 61)).not.toBeNull();
  });

  it("belongs to the request that took it: a lapsed holder can neither release its successor's claim nor make a checkout", async () => {
    const lapsed = (await claimCheckout(db, "u1", "plan", NOW))!;
    expect(await stillHolding(db, lapsed, NOW + 5)).toBe(true);
    const successor = (await claimCheckout(db, "u1", "plan", NOW + 60))!;
    expect(await stillHolding(db, lapsed, NOW + 61)).toBe(false);
    await releaseCheckout(db, lapsed);
    // The successor still holds it, so a third request waits.
    expect(await claimCheckout(db, "u1", "plan", NOW + 61)).toBeNull();
    expect(await stillHolding(db, successor, NOW + 61)).toBe(true);
    // Near the end of its time, even the holder makes nothing.
    expect(await stillHolding(db, successor, NOW + 60 + 55)).toBe(false);
  });
});
