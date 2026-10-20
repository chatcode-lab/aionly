import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readUnsubscribeToken } from "../../app/lib/digest/digest.server";
import { bulkMailer, sesSubject, transactionalMailer } from "../../app/lib/mail/mailers.server";
import { composeOfferEmail } from "../../app/lib/offers/compose";
import { offerDue, sendOfferEmails, sendTestOfferEmails, setOffers } from "../../app/lib/offers/offers.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const HOUR = 3600;

type Sent = { to: string; subject: string; text: string; html: string; from: { name: string; email: string }; replyTo?: string; headers?: Record<string, string> };

/**
 * The database, with `after` run once the sender has read its recipients
 * and before it claims any: a change landing in between, as the review's
 * probes made (F61).
 */
function pausedAfterRead(after: () => Promise<void>): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === "bind") return (...values: unknown[]) => wrap(target.bind(...values));
        if (property === "all") {
          return async () => {
            const result = await target.all();
            await after();
            return result;
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare") {
        return (sql: string) => (sql.includes("ORDER BY profile.created_at") ? wrap(target.prepare(sql)) : target.prepare(sql));
      }
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

describe("a new member's offer emails", () => {
  const sent: Sent[] = [];
  const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as Parameters<typeof sendOfferEmails>[1];
  const refusing = { send: async () => Promise.reject(new Error("refused")) };
  const input = { origin: "https://aion.ly", secret: "s" };

  /** A member who joined `ago` seconds before NOW, with a sign-in email, with offers on unless `offers` is false. */
  async function member(id: string, name: string, ago: number, fields: Parameters<typeof user>[2] & { offers?: boolean } = {}) {
    await user(id, name, fields);
    await db.batch([
      // Past the welcome step, where offers are told and can be turned down.
      db
        .prepare(`UPDATE profiles SET created_at = ?2, welcomed_at = ?2, offers_off_at = ?3 WHERE user_id = ?1`)
        .bind(id, NOW - ago, fields.offers === false ? NOW - ago : null),
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

  it("welcomes a new member, reminds them hours before the price ends, and sends each once", async () => {
    await member("new", "fresh_member", 60);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW, userId: "new" })).toBe(1);
    // The welcome comes from the founder, in their own name (owner's request, 2026-10-21).
    expect(sent[0]).toMatchObject({
      to: "new@example.invalid",
      from: { name: "Boris Karulin", email: "hey@aion.ly" },
      replyTo: "hey@aion.ly",
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
    expect(sent[1]).toMatchObject({ subject: "Your 30% off ends in about 4 hours", from: { name: "aion.ly", email: "noreply@aion.ly" } });
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW + 21 * HOUR })).toBe(0);
    expect(sent).toHaveLength(2);
  });

  it("never mails one who turned offers off, nor a fan, an admin, a banned or deleted account", async () => {
    await member("silent", "silent_member", 60, { offers: false });
    await member("fan", "fan_member", 60, { plan: true });
    await member("boss", "head_admin", 60, { role: "admin" });
    await member("bad", "banned_member", 60, { banReason: "spam" });
    await member("gone", "gone_member", 60, { deletedAt: NOW });
    await member("quiet", "quiet_member", 60);
    await member("old", "old_member", 2 * DAY);
    await setOffers(db, "quiet", false, NOW);
    expect(await db.prepare(`SELECT offers_off_at FROM profiles WHERE user_id = 'quiet'`).first()).toEqual({ offers_off_at: NOW });
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW })).toBe(0);
    expect(sent).toEqual([]);
    // Turned on again in Settings, and offers come.
    await setOffers(db, "silent", true, NOW);
    expect(await db.prepare(`SELECT offers_off_at FROM profiles WHERE user_id = 'silent'`).first()).toEqual({ offers_off_at: null });
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW })).toBe(1);
    expect(sent.map((message) => message.to)).toEqual(["silent@example.invalid"]);
  });

  it("checks again when claiming, so a no, a plan, or a deletion landing after the read stops the send (F61)", async () => {
    const changes: Array<[string, () => Promise<unknown>]> = [
      ["turned offers off", () => setOffers(db, "new", false, NOW)],
      ["became a fan", () => db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'new'`).bind(NOW + 30 * DAY).run()],
      [
        "was deleted",
        () => db.batch([db.prepare(`UPDATE profiles SET deleted_at = ?1 WHERE user_id = 'new'`).bind(NOW), db.prepare(`DELETE FROM "user" WHERE "id" = 'new'`)]),
      ],
    ];
    for (const [what, change] of changes) {
      await reset();
      await db.prepare(`DELETE FROM "user"`).run();
      await member("new", "fresh_member", 60);
      expect(await sendOfferEmails(pausedAfterRead(async () => void (await change())), mailer, { ...input, now: NOW }), what).toBe(0);
    }
    expect(sent).toEqual([]);
  });

  it("fills a batch only with accounts something is due for (F62)", async () => {
    // A hundred and one members two hours in, welcomed already: nothing due for hours.
    for (let n = 0; n < 101; n += 1) await member(`w${n}`, `welcomed_${n}`, 2 * HOUR + n);
    await db.prepare(`UPDATE profiles SET offer_emails = 1`).run();
    await member("late", "newest_member", 60);
    expect(await sendOfferEmails(db, mailer, { ...input, now: NOW })).toBe(1);
    expect(sent.map((message) => message.to)).toEqual(["late@example.invalid"]);
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

  it("are on for a new profile", async () => {
    await user("new", "fresh_member");
    expect(await db.prepare(`SELECT offer_emails, offers_off_at FROM profiles WHERE user_id = 'new'`).first()).toEqual({
      offer_emails: 0,
      offers_off_at: null,
    });
  });

  it("signs the welcome with the founder's picture on the board, while they have one", async () => {
    await user("founder", "boris");
    await db.prepare(`UPDATE profiles SET avatar_key = 'AbCdEfGhIjKlMnOpQrStUvWx.jpg' WHERE user_id = 'founder'`).run();
    await member("new", "fresh_member", 60);
    await sendOfferEmails(db, mailer, { ...input, now: NOW, userId: "new" });
    expect(sent[0]!.html).toContain('<img src="https://aion.ly/img/AbCdEfGhIjKlMnOpQrStUvWx.jpg" width="44" height="44" alt=""');
    await db.prepare(`UPDATE profiles SET avatar_key = NULL WHERE user_id = 'founder'`).run();
    await member("next", "next_member", 60);
    await sendOfferEmails(db, mailer, { ...input, now: NOW, userId: "next" });
    expect(sent[1]!.html).not.toContain("<img");
    expect(sent[1]!.html).toContain("Boris Karulin");
  });

  it("can be sent to an admin as tests, through the offers' own mail service", async () => {
    await member("boss", "head_admin", 300 * DAY, { role: "admin" });
    expect(await sendTestOfferEmails(db, mailer, { ...input, userId: "boss" })).toBeNull();
    expect(sent.map((message) => message.subject)).toEqual([
      "[Test] Welcome to aion.ly: 30% off the Fan plan for 24 hours",
      "[Test] Your 30% off ends in about 4 hours",
    ]);
    expect(await sendTestOfferEmails(db, refusing, { ...input, userId: "boss" })).toBe("refused");
    expect(await sendTestOfferEmails(db, null, { ...input, userId: "boss" })).toMatch(/^Amazon SES is not set up here/);
  });
});

describe("mail through Amazon SES", () => {
  const aws = (env as unknown as Record<string, string | undefined>);
  const saved = { id: aws.AWS_ACCESS_KEY_ID, key: aws.AWS_SECRET_ACCESS_KEY, region: aws.AWS_REGION };
  afterEach(() => {
    aws.AWS_ACCESS_KEY_ID = saved.id;
    aws.AWS_SECRET_ACCESS_KEY = saved.key;
    aws.AWS_REGION = saved.region;
    vi.restoreAllMocks();
  });

  it("holds offers and digests until SES is set up, then sends them as a signed v2 request with the unsubscribe headers", async () => {
    aws.AWS_ACCESS_KEY_ID = undefined;
    aws.AWS_SECRET_ACCESS_KEY = undefined;
    expect(bulkMailer()).toBeNull();
    aws.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
    aws.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    aws.AWS_REGION = "us-east-1";
    const calls: Array<{ url: string; init: RequestInit }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      calls.push({ url: String(input), init: init! });
      return Response.json({ MessageId: "m" });
    });
    const mailer = bulkMailer()!;
    const mail = {
      from: { name: "aion.ly", email: "noreply@aion.ly" },
      replyTo: "hey@aion.ly",
      subject: "Your 30% off ends in about 4 hours",
      html: "<p>hi</p>",
      text: "hi",
      headers: { "List-Unsubscribe": "<https://aion.ly/unsubscribe>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" },
    };
    // An address for examples only: nothing goes out.
    await mailer.send({ ...mail, to: "someone@example.invalid" });
    expect(calls).toEqual([]);
    expect(await mailer.send({ ...mail, to: "member@gmail.com" })).toBe("ses");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://email.us-east-1.amazonaws.com/v2/email/outbound-emails");
    const headers = calls[0]!.init.headers as Record<string, string>;
    expect(headers.Authorization).toMatch(
      /^AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE\/\d{8}\/us-east-1\/ses\/aws4_request, SignedHeaders=content-type;host;x-amz-content-sha256;x-amz-date, Signature=[0-9a-f]{64}$/,
    );
    const body = JSON.parse(String(calls[0]!.init.body));
    expect(body.FromEmailAddress).toBe(`"aion.ly" <noreply@aion.ly>`);
    expect(body.Destination.ToAddresses).toEqual(["member@gmail.com"]);
    expect(body.ReplyToAddresses).toEqual(["hey@aion.ly"]);
    expect(body.Content.Simple.Headers).toEqual([
      { Name: "List-Unsubscribe", Value: "<https://aion.ly/unsubscribe>" },
      { Name: "List-Unsubscribe-Post", Value: "List-Unsubscribe=One-Click" },
    ]);
    expect(body.Content.Simple.Body.Text.Data).toBe("hi");
  });

  it("sends sign-in links and notices through SES, and through Cloudflare when SES is not set up or refuses", async () => {
    const carried: string[] = [];
    const binding = { send: async (message: { to: string }) => (carried.push(message.to), { messageId: "m" }) } as unknown as SendEmail;
    const mail = { from: { name: "aion.ly", email: "noreply@aion.ly" }, subject: "Your aion.ly sign-in link", html: "<p>hi</p>", text: "hi" };
    aws.AWS_ACCESS_KEY_ID = undefined;
    aws.AWS_SECRET_ACCESS_KEY = undefined;
    expect(await transactionalMailer(binding).send({ ...mail, to: "member@gmail.com" })).toBe("cloudflare");
    expect(carried).toEqual(["member@gmail.com"]);

    aws.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
    aws.AWS_SECRET_ACCESS_KEY = "wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY";
    const answer = { status: 200 };
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      answer.status === 200 ? Response.json({ MessageId: "m" }) : new Response('{"message":"The request signature we calculated does not match"}', answer),
    );
    expect(await transactionalMailer(binding).send({ ...mail, to: "member@gmail.com" })).toBe("ses");
    expect(carried).toHaveLength(1);
    answer.status = 403;
    const refusals: string[] = [];
    const mailer = transactionalMailer(binding, (error) => refusals.push(String(error)));
    expect(await mailer.send({ ...mail, to: "member@gmail.com" })).toBe("cloudflare");
    expect(carried).toHaveLength(2);
    expect(refusals[0]).toMatch(/SES answered 403/);
    // Offers and digests have no backup.
    await expect(bulkMailer()!.send({ ...mail, to: "member@gmail.com" })).rejects.toThrow(/SES answered 403/);
    expect(carried).toHaveLength(2);
  });

  it("says when the secret is an SES SMTP password, not a secret access key", async () => {
    aws.AWS_ACCESS_KEY_ID = "AKIDEXAMPLE";
    // The shape of an SMTP password: a version byte of 4 and 32 more, in base64.
    aws.AWS_SECRET_ACCESS_KEY = btoa(String.fromCharCode(4, ...new Uint8Array(32).fill(7)));
    vi.spyOn(globalThis, "fetch").mockImplementation(
      async () => new Response('{"message":"The request signature we calculated does not match the signature you provided."}', { status: 403 }),
    );
    const mail = { from: { name: "aion.ly", email: "noreply@aion.ly" }, subject: "s", html: "h", text: "t", to: "member@gmail.com" };
    await expect(bulkMailer()!.send(mail)).rejects.toThrow(/looks like an SES SMTP password/);
  });

  it("encodes a subject SES would refuse as it is", () => {
    expect(sesSubject("Plain subject")).toBe("Plain subject");
    expect(sesSubject("Welcome — 30% off")).toBe(`=?UTF-8?B?${btoa(String.fromCharCode(...new TextEncoder().encode("Welcome — 30% off")))}?=`);
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
    expect(email.text).toContain("You get this as a new member of aion.ly, with offers by email on. Reply to reach me.");
    expect(email.text).toContain("Unsubscribe from offers: https://aion.ly/unsubscribe?list=offers&token=t");
  });

  it("welcomes as the founder's own letter: who they are, where to find them, and their picture", () => {
    const email = composeOfferEmail({
      kind: "welcome",
      left: 24 * HOUR,
      origin: "https://aion.ly",
      unsubscribeUrl: "https://aion.ly/unsubscribe?list=offers&token=t",
      founderPhoto: "https://media.example/face.jpg",
    });
    expect(email.text).toContain("Hi, I'm Boris, and I started aion.ly: a place where people and their agents discover and discuss all things AI, together. Thank you for joining.");
    expect(email.text).toContain("I read every reply to this email, and I'm on the board as @boris.");
    expect(email.text).toContain(["Boris Karulin", "@boris on aion.ly: https://aion.ly/@boris", "@karulin on X: https://x.com/karulin", "hey@aion.ly: mailto:hey@aion.ly"].join("\n"));
    expect(email.html).toContain('<img src="https://media.example/face.jpg"');
    expect(email.html).toContain('href="https://aion.ly/@boris"');
    expect(email.html).toContain('href="https://x.com/karulin"');
    // The reminder stays the board's own.
    const reminder = composeOfferEmail({ kind: "reminder", left: 4 * HOUR, origin: "https://aion.ly", unsubscribeUrl: "https://aion.ly/u" });
    expect(reminder.text).not.toContain("Boris Karulin");
    expect(reminder.text).toContain("Reply to reach a person.");
  });
});
