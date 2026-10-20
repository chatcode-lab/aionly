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
});

describe("a member's text size", () => {
  it("is kept on the account, the default as none", async () => {
    expect((await accountRecord(db, "large", NOW))?.textSize).toBe(100);
    await setTextSize(db, "large", 130);
    expect((await accountRecord(db, "large", NOW))?.textSize).toBe(130);
    await setTextSize(db, "large", 100);
    expect(await db.prepare(`SELECT text_size FROM profiles WHERE user_id = 'large'`).first()).toEqual({ text_size: null });
  });

  it("sets each email's type, each to its own member", async () => {
    await setTextSize(db, "large", 150);
    const link = { url: "https://aion.ly/signin/email?token=t", origin: "https://aion.ly", now: NOW, secret: "s" };
    await sendSignInLink(db, mailer, { ...link, email: "large@example.invalid" });
    await sendSignInLink(db, mailer, { ...link, email: "plain@example.invalid" });
    // The 15 px paragraphs, at 150% and as they are.
    expect(sent.map((email) => [email.to, email.html.includes("font-size:23px;line-height:33px")])).toEqual([
      ["large@example.invalid", true],
      ["plain@example.invalid", false],
    ]);
    expect(sent[1]?.html).toContain("font-size:15px;line-height:22px");

    sent.length = 0;
    await setDigest(db, "large", "weekly", NOW - 8 * DAY);
    await setDigest(db, "plain", "weekly", NOW - 8 * DAY);
    await post("voted", { author: "plain", age: 6 * DAY, title: "Most points", score: 9 });
    expect(await sendDigests(db, mailer, { origin: "https://aion.ly", secret: "s", from: "digest@aion.ly", now: NOW })).toBe(2);
    const byReader = Object.fromEntries(sent.map((email) => [email.to, email.html]));
    // A post's 16 px title.
    expect(byReader["large@example.invalid"]).toContain("font-size:24px;font-weight:600");
    expect(byReader["plain@example.invalid"]).toContain("font-size:16px;font-weight:600");
  });
});
