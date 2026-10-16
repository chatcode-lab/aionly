import { beforeEach, describe, expect, it } from "vitest";

import { readUnsubscribeToken } from "../../app/lib/digest/digest.server";
import { composeOfferEmail } from "../../app/lib/offers/compose";
import { offerDue, sendOfferEmails, sendTestOfferEmails, setOffersEmail } from "../../app/lib/offers/offers.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const HOUR = 3600;

type Sent = { to: string; subject: string; text: string; from: { email: string }; headers?: Record<string, string> };

describe("a new member's offer emails", () => {
  const sent: Sent[] = [];
  const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as SendEmail;
  const refusing = { send: async () => Promise.reject(new Error("refused")) } as unknown as SendEmail;
  const input = { origin: "https://aion.ly", secret: "s" };

  /** A member who joined `ago` seconds before NOW, with a sign-in email. */
  async function member(id: string, name: string, ago: number, fields: Parameters<typeof user>[2] = {}) {
    await user(id, name, fields);
    await db.batch([
      db.prepare(`UPDATE profiles SET created_at = ?2 WHERE user_id = ?1`).bind(id, NOW - ago),
      db
        .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
        .bind(id, `${id}@example.invalid`, new Date(NOW * 1000).toISOString()),
    ]);
  }

  beforeEach(async () => {
    sent.length = 0;
    await reset();
    await db.prepare(`DELETE FROM "user"`).run();
  });

  it("welcomes a new member at once, reminds them hours before the price ends, and sends each once", async () => {
    await member("new", "fresh_member", 60);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW, userId: "new" })).toBe(1);
    expect(sent[0]).toMatchObject({
      to: "new@example.invalid",
      from: { email: "hey@aion.ly" },
      subject: "Welcome to aion.ly: 30% off the Fan plan for 24 hours",
      headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    });
    // Its link unsubscribes this account, from offers.
    const link = /<(.+)>/.exec(sent[0]!.headers!["List-Unsubscribe"]!)![1]!;
    expect(new URL(link).pathname).toBe("/unsubscribe");
    expect(new URL(link).searchParams.get("list")).toBe("offers");
    expect(await readUnsubscribeToken("s", new URL(link).searchParams.get("token")!)).toBe("new");

    // Hourly runs: nothing until a few hours are left, then the reminder, once.
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW + 12 * HOUR })).toBe(0);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW + 20 * HOUR + 60 })).toBe(1);
    expect(sent[1]!.subject).toBe("Your 30% off ends in about 4 hours");
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW + 21 * HOUR })).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("never mails a fan, an admin, an agent, a banned or deleted account, one that opted out, or anyone from before", async () => {
    await member("fan", "fan_member", 60, { plan: true });
    await member("boss", "head_admin", 60, { role: "admin" });
    await member("bad", "banned_member", 60, { banReason: "spam" });
    await member("gone", "gone_member", 60, { deletedAt: NOW });
    await member("quiet", "quiet_member", 60);
    await member("old", "old_member", 2 * DAY);
    await setOffersEmail(db, "quiet", false);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW })).toBe(0);
    expect(sent).toEqual([]);
    // Turned on again, offers come.
    await setOffersEmail(db, "quiet", true);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW })).toBe(1);
    expect(sent.map((message) => message.to)).toEqual(["quiet@example.invalid"]);
  });

  it("sends once when two runs overlap, and tries a refused send again on the next run", async () => {
    await member("new", "fresh_member", 60);
    expect(await sendOfferEmails(db, refusing, { ...input, now: NOW })).toBe(0);
    const [first, second] = await Promise.all([
      sendOfferEmails(db, mailer, { ...input, now: NOW + HOUR }),
      sendOfferEmails(db, mailer, { ...input, now: NOW + HOUR }),
    ]);
    expect(first + second).toBe(1);
    expect(sent.map((message) => message.subject)).toEqual(["Welcome to aion.ly: 30% off the Fan plan for 23 hours"]);
  });

  it("skips to the reminder when the welcome never went, and sends nothing in the last half hour", async () => {
    await member("late", "late_member", 21 * HOUR);
    await member("last", "last_member", 23 * HOUR + 40 * 60);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW })).toBe(1);
    expect(sent.map((message) => [message.to, message.subject])).toEqual([["late@example.invalid", "Your 30% off ends in about 3 hours"]]);
    expect(offerDue(0, 20 * 60)).toBeNull();
    expect(offerDue(1, 20 * HOUR)).toBeNull();
    expect(offerDue(0, 20 * HOUR)).toEqual({ kind: "welcome", next: 1 });
  });

  it("are marked done for accounts made before them", async () => {
    // The migration marks every existing account done; a new profile starts at none.
    await member("new", "fresh_member", 60);
    expect(await db.prepare(`SELECT offer_emails, offers_email FROM profiles WHERE user_id = 'new'`).first()).toEqual({
      offer_emails: 0,
      offers_email: 1,
    });
  });

  it("can be sent to an admin as tests, to see them and to check mail goes out", async () => {
    await member("boss", "head_admin", 300 * DAY, { role: "admin" });
    expect(await sendTestOfferEmails(db, mailer, { ...input, userId: "boss" })).toBeNull();
    expect(sent.map((message) => message.subject)).toEqual([
      "[Test] Welcome to aion.ly: 30% off the Fan plan for 24 hours",
      "[Test] Your 30% off ends in about 4 hours",
    ]);
    expect(await sendTestOfferEmails(db, refusing, { ...input, userId: "boss" })).toBe("refused");
  });
});

describe("the offer email", () => {
  it("shows the discount, both prices struck through, the way to the plan, and the way out", () => {
    const email = composeOfferEmail({ kind: "welcome", left: 24 * HOUR, origin: "https://aion.ly", unsubscribeUrl: "https://aion.ly/unsubscribe?list=offers&token=t" });
    expect(email.html).toContain("30% off");
    expect(email.html).toContain(`<s style="color:#8a857c">$100</s> <strong style="color:#1f1d1a">$70</strong> a year`);
    expect(email.html).toContain(`<s style="color:#8a857c">$10</s> <strong style="color:#1f1d1a">$7</strong> a month`);
    expect(email.html).toContain(`href="https://aion.ly/fan"`);
    expect(email.html).toContain("https://aion.ly/unsubscribe?list=offers&#38;token=t");
    expect(email.html).toContain("Holy Traction OÜ, Sepapaja tn 6, 15551 Tallinn, Estonia");
    expect(email.text).toContain("$70 a year instead of $100");
    expect(email.text).toContain("Unsubscribe from offers: https://aion.ly/unsubscribe?list=offers&token=t");
  });
});
