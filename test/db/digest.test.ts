import { beforeEach, describe, expect, it } from "vitest";

import { dueRecipients, sendDigests, sendTestDigest, setDigest } from "../../app/lib/digest/digest.server";
import type { Mailer } from "../../app/lib/mail/mailers.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

// NOW is Friday, 15 January 2027, 08:00 UTC: the daily digest covers from
// 07:00 the day before, the weekly one Monday 4 to Monday 11 January, and
// the monthly one December.
const HOUR = 3600;

interface Sent {
  to: string;
  subject: string;
  html: string;
  text: string;
}

const sent: Sent[] = [];
const mailer = { send: async (message: Sent) => (sent.push(message), { messageId: "m" }) } as unknown as Mailer;
const input = { origin: "https://aion.ly", secret: "s", from: "digest@aion.ly", now: NOW };

async function member(id: string, name: string) {
  await user(id, name);
  await db
    .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
    .bind(id, `${id}@example.invalid`, new Date(NOW * 1000).toISOString())
    .run();
}

/** Comments on a post by `author`, keeping its count as the board does. */
async function discuss(postId: string, author: string, count: number) {
  for (let n = 0; n < count; n += 1) await comment(`${postId}_${author}_${n}`, { post: postId, author, age: 60 });
  await db.prepare(`UPDATE posts SET comment_count = comment_count + ?2 WHERE id = ?1`).bind(postId, count).run();
}

beforeEach(async () => {
  await reset();
  sent.length = 0;
  await db.prepare(`DELETE FROM "user"`).run();
  await member("reader", "keen_reader");
  await member("maker", "busy_maker");
  await user("helper", "maker_agent");
  await db.prepare(`UPDATE profiles SET owner_id = 'maker' WHERE user_id = 'helper'`).run();
});

describe("a digest's posts", () => {
  beforeEach(async () => {
    await setDigest(db, "reader", "weekly", NOW - 8 * DAY);
  });

  it("are the most voted and the most discussed apart, each once, and only those that stand out", async () => {
    const week = { author: "maker", age: 6 * DAY };
    await post("voted1", { ...week, title: "Most points", score: 9 });
    await post("voted2", { ...week, title: "Just enough points", score: 5 });
    await post("quiet", { ...week, title: "Too few points", score: 4 });
    await post("talked", { ...week, title: "Much discussed", score: 2 });
    await discuss("talked", "reader", 5);
    await post("both", { ...week, title: "Voted and discussed", score: 7 });
    await discuss("both", "reader", 9);
    await post("disliked", { ...week, title: "Discussed but disliked", score: 0 });
    await discuss("disliked", "reader", 8);
    await post("own", { ...week, title: "Talking to itself", score: 3 });
    await discuss("own", "maker", 3);
    await discuss("own", "helper", 3);

    expect(await sendDigests(db, mailer, input)).toBe(1);
    const [email] = sent;
    expect(email?.subject).toBe("Last week on aion.ly: Most points");
    const order = ["MOST VOTED", "Most points", "Voted and discussed", "Just enough points", "MOST DISCUSSED", "Much discussed"];
    expect(order.map((line) => email!.text.indexOf(line))).toEqual([...order.map((line) => email!.text.indexOf(line))].sort((a, b) => a - b));
    expect(email!.text.split("Voted and discussed")).toHaveLength(2);
    for (const left of ["Too few points", "Discussed but disliked", "Talking to itself"]) expect(email!.text).not.toContain(left);
  });

  it("follow the bar in the settings", async () => {
    await post("p1", { author: "maker", age: 6 * DAY, title: "Three points", score: 3 });
    await db.prepare(`INSERT INTO settings (key, value, updated_at, updated_by) VALUES ('digest_points', 3, ?1, 'maker')`).bind(NOW).run();
    expect(await sendDigests(db, mailer, input)).toBe(1);
    expect(sent[0]?.subject).toBe("Last week on aion.ly: Three points");
  });

  it("make no digest when nothing stands out, which still counts as sent", async () => {
    await post("p1", { author: "maker", age: 6 * DAY, score: 4 });
    await post("p2", { author: "maker", age: 6 * DAY, score: 1 });
    await discuss("p2", "reader", 4);
    expect(await sendDigests(db, mailer, input)).toBe(0);
    expect(sent).toEqual([]);
    expect(await dueRecipients(db, "weekly", NOW)).toEqual([]);
  });
});

describe("digests of one kind", () => {
  it("never list a post twice, however late in its period each was sent", async () => {
    await setDigest(db, "reader", "daily", NOW - 3 * DAY);
    // Before and after the 07:00 boundary; both exist when the first goes out.
    await post("before", { author: "maker", age: 90 * 60, title: "Made before seven", score: 6 });
    await post("after", { author: "maker", age: 30 * 60, title: "Made after seven", score: 8 });

    await sendDigests(db, mailer, { ...input, now: NOW + 2 * HOUR });
    expect(sent.map((email) => email.subject)).toEqual(["The past day on aion.ly: Made before seven"]);
    expect(sent[0]!.text).not.toContain("Made after seven");

    await sendDigests(db, mailer, { ...input, now: NOW + DAY - 90 * 60 });
    expect(sent).toHaveLength(1);
    await sendDigests(db, mailer, { ...input, now: NOW + DAY });
    expect(sent.map((email) => email.subject)).toEqual([
      "The past day on aion.ly: Made before seven",
      "The past day on aion.ly: Made after seven",
    ]);
    expect(sent[1]!.text).not.toContain("Made before seven");
  });
});

describe("the daily digest", () => {
  it("brings the weekly and monthly ones, and the weekly one the monthly", async () => {
    await member("weekly", "week_reader");
    await member("monthly", "month_reader");
    await setDigest(db, "reader", "daily", NOW - 60 * DAY);
    await setDigest(db, "weekly", "weekly", NOW - 60 * DAY);
    await setDigest(db, "monthly", "monthly", NOW - 60 * DAY);
    await post("day", { author: "maker", age: DAY, title: "Of the day", score: 5 });
    await post("week", { author: "maker", age: 6 * DAY, title: "Of the week", score: 5 });
    await post("month", { author: "maker", age: 20 * DAY, title: "Of December", score: 5 });

    expect(await sendDigests(db, mailer, input)).toBe(6);
    const got = (to: string) => sent.filter((email) => email.to === `${to}@example.invalid`).map((email) => email.subject);
    expect(got("reader")).toEqual([
      "The past day on aion.ly: Of the day",
      "Last week on aion.ly: Of the week",
      "December on aion.ly: Of December",
    ]);
    expect(got("weekly")).toEqual(["Last week on aion.ly: Of the week", "December on aion.ly: Of December"]);
    expect(got("monthly")).toEqual(["December on aion.ly: Of December"]);
    const brought = sent.find((email) => email.to === "reader@example.invalid" && email.subject.startsWith("Last week"));
    expect(brought?.text).toContain("It comes with the daily digest you turned on.");
  });

  it("chosen later, starts each digest it newly brings with that digest's next period", async () => {
    await setDigest(db, "reader", "monthly", NOW - 60 * DAY);
    await setDigest(db, "reader", "daily", NOW - HOUR / 2);
    const at = await db
      .prepare(`SELECT daily_digest_at, weekly_digest_at, monthly_digest_at FROM profiles WHERE user_id = 'reader'`)
      .first();
    expect(at).toEqual({ daily_digest_at: NOW - HOUR / 2, weekly_digest_at: NOW - HOUR / 2, monthly_digest_at: NOW - 60 * DAY });
    // The month's is still due; today's and this week's come with their next periods.
    expect((await dueRecipients(db, "monthly", NOW)).map((row) => row.userId)).toEqual(["reader"]);
    expect(await dueRecipients(db, "weekly", NOW)).toEqual([]);
    expect(await dueRecipients(db, "daily", NOW)).toEqual([]);
  });
});

describe("an admin's test digest", () => {
  const test = { userId: "reader", origin: "https://aion.ly", secret: "s", from: "digest@aion.ly", now: NOW };

  it("is the past week's, and goes even when nothing stands out, saying members get none", async () => {
    await post("small", { author: "maker", age: 2 * DAY, title: "Small one", score: 1 });
    expect(await sendTestDigest(db, mailer, test)).toBeNull();
    expect(sent[0]?.subject).toBe("[Test, nothing notable: members get none] The past month on aion.ly: Small one");

    await post("big", { author: "maker", age: 2 * DAY, title: "Big one", score: 6 });
    expect(await sendTestDigest(db, mailer, test)).toBeNull();
    expect(sent[1]?.subject).toBe("[Test] The past week on aion.ly: Big one");
    expect(sent[1]?.text).not.toContain("Small one");
  });
});
