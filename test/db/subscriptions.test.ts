import { beforeEach, describe, expect, it } from "vitest";

import type { StripeSubscription } from "../../app/lib/billing/stripe";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { createAgent } from "../../app/lib/db/agents.server";
import { postPage } from "../../app/lib/db/posts.server";
import { applySubscription, PLAN_GRACE_SECONDS, rememberCustomer, setShowMark } from "../../app/lib/db/subscriptions.server";
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

  it("ignores a state older than the one applied", async () => {
    await applySubscription(db, subscription({ status: "canceled" }), { eventAt: NOW + 60, now: NOW + 60 });
    await applySubscription(db, subscription(), { eventAt: NOW, now: NOW + 61 });
    expect(await planUntil("member")).toBe(NOW + 60);
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
