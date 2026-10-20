import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord, setTextSize } from "../../app/lib/db/accounts.server";
import { sendDigests, setDigest } from "../../app/lib/digest/digest.server";
import type { Mailer } from "../../app/lib/mail/mailers.server";
import { sendSignInLink } from "../../app/lib/notices/notices.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

interface Sent {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const sent: Sent[] = [];
const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as Mailer;

async function member(id: string, name: string) {
  await user(id, name);
  await db
    .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
    .bind(id, `${id}@example.invalid`, new Date(NOW * 1000).toISOString())
    .run();
}

beforeEach(async () => {
  await reset();
  sent.length = 0;
  await db.batch([db.prepare(`DELETE FROM sign_in_link_sends`), db.prepare(`DELETE FROM "user"`)]);
  await member("large", "large_reader");
  await member("plain", "plain_reader");
  await member("small", "small_reader");
});

describe("a member's text size", () => {
  it("is kept on the account, Normal, everyone's default, as none", async () => {
    expect((await accountRecord(db, "large", NOW))?.textSize).toBe(115);
    await setTextSize(db, "large", 130);
    expect((await accountRecord(db, "large", NOW))?.textSize).toBe(130);
    await setTextSize(db, "large", 115);
    expect(await db.prepare(`SELECT text_size FROM profiles WHERE user_id = 'large'`).first()).toEqual({ text_size: null });
  });

  it("sets each email's type, each to its own member", async () => {
    await setTextSize(db, "large", 130);
    await setTextSize(db, "small", 100);
    const link = { url: "https://aion.ly/signin/email?token=t", origin: "https://aion.ly", now: NOW, secret: "s" };
    for (const name of ["large", "plain", "small"]) await sendSignInLink(db, mailer, { ...link, email: `${name}@example.invalid` });
    // The 15 px paragraphs with 22 px lines: Big, Normal, and Small, as drawn.
    expect(sent.map((email) => [email.to, /color:#55524c;font-size:(\d+)px;line-height:(\d+)px/.exec(email.html)?.slice(1)])).toEqual([
      ["large@example.invalid", ["20", "29"]],
      ["plain@example.invalid", ["17", "25"]],
      ["small@example.invalid", ["15", "22"]],
    ]);

    sent.length = 0;
    await setDigest(db, "large", "weekly", NOW - 8 * DAY);
    await setDigest(db, "plain", "weekly", NOW - 8 * DAY);
    await post("voted", { author: "plain", age: 6 * DAY, title: "Most points", score: 9 });
    expect(await sendDigests(db, mailer, { origin: "https://aion.ly", secret: "s", from: "digest@aion.ly", now: NOW })).toBe(2);
    const byReader = Object.fromEntries(sent.map((email) => [email.to, email.html]));
    // A post's 16 px title.
    expect(byReader["large@example.invalid"]).toContain("font-size:21px;font-weight:600");
    expect(byReader["plain@example.invalid"]).toContain("font-size:18px;font-weight:600");
  });
});
