import { beforeEach, describe, expect, it } from "vitest";

import { claimCheckoutReturn, releaseCheckoutReturn } from "../../app/lib/db/subscriptions.server";
import { deliverable } from "../../app/lib/mail/address";
import { composePlanEndNotice, composeReadOnlyNotice, composeSignInLink } from "../../app/lib/notices/notices";
import { sendPlanEndNotices, sendReadOnlyNotices } from "../../app/lib/notices/notices.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

type Sent = { to: string; subject: string; text: string; from: { email: string }; replyTo?: string };

describe("the read-only notice", () => {
  const sent: Sent[] = [];
  const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as Parameters<typeof sendReadOnlyNotices>[1];
  const refusing = { send: async () => Promise.reject(new Error("refused")) };
  const input = { origin: "https://aion.ly" };

  async function member(id: string, name: string, karma: number, fields: Parameters<typeof user>[2] = {}) {
    await user(id, name, { ...fields, karma });
    await db
      .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
      .bind(id, `${id}@example.invalid`, new Date(NOW * 1000).toISOString())
      .run();
  }

  beforeEach(async () => {
    sent.length = 0;
    await reset();
    await db.prepare(`DELETE FROM "user"`).run();
  });

  it("tells a member at the floor once, with the ways back, and again after a later fall", async () => {
    await member("low", "low_member", -120);
    await member("fine", "fine_member", 5);
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW })).toBe(1);
    expect(sent[0]).toMatchObject({
      to: "low@example.invalid",
      from: { email: "noreply@aion.ly" },
      replyTo: "hey@aion.ly",
      subject: "Your aion.ly account is read-only for now",
    });
    expect(sent[0]!.text).toContain("Your karma reached -120, at or below -100");
    expect(sent[0]!.text).toContain("See the ways back: https://aion.ly/fresh-start");
    // Once each fall.
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW + 3600 })).toBe(0);
    // Back above the floor, and a week on, a new fall is a new notice.
    await db.prepare(`UPDATE profiles SET karma = 0 WHERE user_id = 'low'`).run();
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW + 8 * DAY })).toBe(0);
    await db.prepare(`UPDATE profiles SET karma = -101 WHERE user_id = 'low'`).run();
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW + 8 * DAY + 3600 })).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("follows a fresh start's own floor, and skips admins, agents, banned and deleted accounts", async () => {
    await member("fresh", "fresh_start", -120);
    await db.prepare(`UPDATE profiles SET karma_floor = -170 WHERE user_id = 'fresh'`).run();
    await member("boss", "head_admin", -500, { role: "admin" });
    await member("bad", "banned_member", -500, { banReason: "spam" });
    await member("gone", "gone_member", -500, { deletedAt: NOW });
    await user("bot", "some_agent", { karma: -500 });
    await db.prepare(`UPDATE profiles SET owner_id = 'boss' WHERE user_id = 'bot'`).run();
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW })).toBe(0);
    await db.prepare(`UPDATE profiles SET karma = -170 WHERE user_id = 'fresh'`).run();
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW })).toBe(1);
    expect(sent.map((message) => message.to)).toEqual(["fresh@example.invalid"]);
  });

  it("tries a refused send again on the next run", async () => {
    await member("low", "low_member", -120);
    expect(await sendReadOnlyNotices(db, refusing, { ...input, now: NOW })).toBe(0);
    expect(await sendReadOnlyNotices(db, mailer, { ...input, now: NOW + 3600 })).toBe(1);
  });
});

describe("the plan's end notice", () => {
  const sent: Sent[] = [];
  const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as Parameters<typeof sendPlanEndNotices>[1];
  const refusing = { send: async () => Promise.reject(new Error("refused")) };
  const input = { origin: "https://aion.ly" };

  async function fan(id: string, name: string, fields: Parameters<typeof user>[2] = { plan: "year" }) {
    await user(id, name, fields);
    await db
      .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
      .bind(id, `${id}@example.invalid`, new Date(NOW * 1000).toISOString())
      .run();
  }
  /** Sets the member's plan to end at `end`, as cancelling does, or not. */
  const ending = (id: string, end: number, cancelled = true) =>
    db.batch([
      db.prepare(`UPDATE subscriptions SET cancel_at_period_end = ?2, period_end = ?3 WHERE user_id = ?1`).bind(id, cancelled ? 1 : 0, end),
      db.prepare(`UPDATE profiles SET plan_until = ?2 WHERE user_id = ?1`).bind(id, end + 3 * DAY),
    ]);

  beforeEach(async () => {
    sent.length = 0;
    await reset();
    await db.prepare(`DELETE FROM "user"`).run();
  });

  it("tells a member a week before the plan they cancelled ends, once, with what stops and that a short name is not certain", async () => {
    await fan("nova", "nova");
    await fan("long", "long_member");
    await ending("nova", NOW + 20 * DAY);
    await ending("long", NOW + 20 * DAY, false);
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW })).toBe(0);
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW + 14 * DAY })).toBe(1);
    expect(sent[0]).toMatchObject({ to: "nova@example.invalid", from: { email: "noreply@aion.ly" }, subject: expect.stringMatching(/^Your aion\.ly Fan plan ends on \d+ \w+ \d{4}$/) });
    expect(sent[0]!.text).toContain("From then on, your agent pauses, and new text posts, uploads");
    expect(sent[0]!.text).toContain("Your username, nova, stays yours, but no longer for certain");
    expect(sent[0]!.text).toContain("Keep your plan: https://aion.ly/settings");
    // Once, even as it ends.
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW + 15 * DAY })).toBe(0);
    await db.prepare(`UPDATE subscriptions SET status = 'canceled' WHERE user_id = 'nova'`).run();
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'nova'`).bind(NOW + 20 * DAY).run();
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW + 21 * DAY })).toBe(0);
    // Resumed and cancelled again, it is told again.
    await db.prepare(`UPDATE subscriptions SET status = 'active' WHERE user_id = 'nova'`).run();
    await ending("nova", NOW + 50 * DAY, false);
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW + 30 * DAY })).toBe(0);
    await ending("nova", NOW + 50 * DAY);
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW + 45 * DAY })).toBe(1);
    expect(sent).toHaveLength(2);
  });

  it("tells a member whose plan ended without warning, within a week, and skips admins, agents, and the deleted", async () => {
    await fan("lapsed", "lapsed_member", { plan: true });
    await fan("old", "old_member", { plan: true });
    await fan("boss", "head_admin", { role: "admin", plan: true });
    await fan("gone", "gone_member", { plan: true, deletedAt: NOW });
    await user("bot", "some_agent", { plan: true });
    await db.prepare(`UPDATE profiles SET owner_id = 'boss' WHERE user_id = 'bot'`).run();
    await db.batch([
      db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id IN ('lapsed', 'boss', 'gone', 'bot')`).bind(NOW - DAY),
      db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'old'`).bind(NOW - 10 * DAY),
    ]);
    expect(await sendPlanEndNotices(db, refusing, { ...input, now: NOW })).toBe(0);
    // A refused send is tried again.
    expect(await sendPlanEndNotices(db, mailer, { ...input, now: NOW + 3600 })).toBe(1);
    expect(sent.map((message) => [message.to, message.subject])).toEqual([["lapsed@example.invalid", "Your aion.ly Fan plan has ended"]]);
    expect(sent[0]!.text).toContain("From now on, your agent pauses");
    expect(sent[0]!.text).not.toContain("no longer for certain");
    expect(sent[0]!.text).toContain("Become a fan again: https://aion.ly/fan");
  });
});

describe("notices", () => {
  it("say what they are, with one button and no offer", () => {
    const link = composeSignInLink({ url: "https://aion.ly/signin/email?token=t", origin: "https://aion.ly" });
    expect(link.subject).toBe("Your aion.ly sign-in link");
    expect(link.text).toContain("Sign in: https://aion.ly/signin/email?token=t");
    expect(link.html).toContain(`href="https://aion.ly/signin/email?token=t"`);
    const notice = composeReadOnlyNotice({ karma: -103, floor: -100, room: 50, origin: "https://aion.ly" });
    expect(notice.text).toContain("A fresh start, from $20 plus VAT, lets you take part again at once, with 50 karma of room; we keep none of it, and give it to a cause members choose.");
    expect(notice.html).not.toContain("30% off");
    const ended = composePlanEndNotice({ endsAt: null, username: "nova", shortName: true, origin: "https://aion.ly" });
    expect(ended.subject).toBe("Your aion.ly Fan plan has ended");
    expect(ended.text).toContain("Your username, nova, stays yours, but no longer for certain: if someone else asks for it, it may go to them");
  });
});

describe("addresses", () => {
  it("that reach nobody are never mailed", () => {
    expect(deliverable("member@gmail.com")).toBe(true);
    expect(deliverable("member@aion.ly")).toBe(true);
    for (const address of ["a@example.invalid", "a@example.com", "a@mail.example.org", "a@host.test", "a@localhost", "a@nowhere"]) {
      expect(deliverable(address), address).toBe(false);
    }
  });
});

describe("a checkout's return", () => {
  beforeEach(reset);

  it("applies what it carried once, unless that failed", async () => {
    await user("fan", "fan_member");
    expect(await claimCheckoutReturn(db, "cs_1", "fan", NOW)).toBe(true);
    expect(await claimCheckoutReturn(db, "cs_1", "fan", NOW + 60)).toBe(false);
    await releaseCheckoutReturn(db, "cs_1");
    expect(await claimCheckoutReturn(db, "cs_1", "fan", NOW + 120)).toBe(true);
  });
});
