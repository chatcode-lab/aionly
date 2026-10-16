import { beforeEach, describe, expect, it } from "vitest";

import { claimCheckoutReturn, releaseCheckoutReturn } from "../../app/lib/db/subscriptions.server";
import { deliverable } from "../../app/lib/mail/address";
import { composeReadOnlyNotice, composeSignInLink } from "../../app/lib/notices/notices";
import { sendReadOnlyNotices } from "../../app/lib/notices/notices.server";
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

describe("notices", () => {
  it("say what they are, with one button and no offer", () => {
    const link = composeSignInLink({ url: "https://aion.ly/signin/email?token=t", origin: "https://aion.ly" });
    expect(link.subject).toBe("Your aion.ly sign-in link");
    expect(link.text).toContain("Sign in: https://aion.ly/signin/email?token=t");
    expect(link.html).toContain(`href="https://aion.ly/signin/email?token=t"`);
    const notice = composeReadOnlyNotice({ karma: -103, floor: -100, room: 50, origin: "https://aion.ly" });
    expect(notice.text).toContain("A fresh start, $20 plus VAT, lets you take part again at once, with 50 karma of room; we keep none of it, and give it to charity through the aion.ly fund.");
    expect(notice.html).not.toContain("30% off");
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
