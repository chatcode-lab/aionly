import { beforeEach, describe, expect, it } from "vitest";

import { EXCERPT_MAX } from "../../app/lib/digest/compose";
import { dueRecipients, sendDigests, sendTestDigest, setDigest } from "../../app/lib/digest/digest.server";
import type { Mailer } from "../../app/lib/mail/mailers.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

// NOW is Friday, 15 January 2027, 08:00 UTC. The daily digest due at 07:00
// covers 23:00 on the 13th to 23:00 on the 14th; the weekly one, due Monday
// the 11th at 19:00, the week to Sunday the 10th at 23:00; the monthly one,
// due Friday the 1st at 19:00, December.
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

  it("show each author's picture, and end with the founder's note under their own picture", async () => {
    await user("founder", "boris");
    await db.prepare(`UPDATE profiles SET avatar_key = ?2 WHERE user_id = ?1`).bind("maker", "makerface.jpg").run();
    await db.prepare(`UPDATE profiles SET avatar_key = ?2 WHERE user_id = ?1`).bind("founder", "borisface.jpg").run();
    await post("mine", { author: "maker", age: 6 * DAY, title: "Pictured", score: 9 });
    await post("theirs", { author: "helper", age: 6 * DAY, title: "Drawn", score: 8 });

    expect(await sendDigests(db, mailer, input)).toBe(1);
    const { html } = sent[0]!;
    expect(html).toMatch(/by <img src="https:\/\/[^"]*\/makerface\.jpg" width="16" height="16" alt=""[^>]*>busy_maker<\/span><\/div>/);
    expect(html).toMatch(/by <span style="[^"]*">M<\/span>maker_agent<\/span><\/div>/);
    expect(html).toMatch(/<img src="https:\/\/[^"]*\/borisface\.jpg" width="44" height="44"/);
    expect(html).toContain("What do you think of this digest?");
  });

  it("name each source, a well-known site by its name, as a quiet link to it", async () => {
    await post("named", { author: "maker", age: 6 * DAY, title: "Named", score: 9, url: "https://blog.anthropic.com/news/proteins" });
    await post("bare", { author: "maker", age: 6 * DAY, title: "Bare", score: 8, url: "https://www.peec.ai/blog/stats" });

    expect(await sendDigests(db, mailer, input)).toBe(1);
    const { html, text } = sent[0]!;
    expect(html).toContain('<a href="https://blog.anthropic.com/news/proteins" style="color:#6f6b64;text-decoration:none" class="dc-6f6b64">Anthropic</a> · 9 points');
    expect(html).toContain('<a href="https://www.peec.ai/blog/stats" style="color:#6f6b64;text-decoration:none" class="dc-6f6b64">peec.ai</a> · 8 points');
    expect(text).toContain("Anthropic · 9 points · 0 comments · by busy_maker");
  });

  it("name a post the board hosts by where it leads, or else by what it is, never as a text post or an upload (owner's request, 2026-10-27)", async () => {
    const week = { author: "maker", age: 6 * DAY };
    const hosted = async (id: string, score: number, fields: Record<string, string | null>) => {
      await post(id, { ...week, title: id, score, ...(fields.description ? { description: fields.description } : {}) });
      await db
        .prepare(
          `UPDATE posts SET kind = ?2, url = NULL, canonical_key = NULL, media_key = ?3, media_type = ?4, pictures = ?5, card_preview = ?6 WHERE id = ?1`,
        )
        .bind(id, fields.kind, fields.media_type ? "A0qaaxh7fPyMWEyHRJ3kLnqy.jpg" : null, fields.media_type ?? null, fields.pictures ?? null, fields.card_preview ?? null)
        .run();
    };
    const pictures = JSON.stringify([{ key: "A0qaaxh7fPyMWEyHRJ3kLnqy.jpg" }, { key: "dvoCUsCDAjaZlcb97lrtSdMp.png" }]);
    await hosted("Repo", 9, { kind: "text", card_preview: JSON.stringify({ link: "https://github.com/maker/tool" }) });
    await hosted("Essay", 8, { kind: "text", description: "See [the demo](https://youtube.com/watch?v=x) first." });
    await hosted("Demo", 7, { kind: "upload", media_type: "video", description: "More on [our site](https://aion.ly/p/x), and the code at https://github.com/maker/demo." });
    await hosted("Clip", 6, { kind: "upload", media_type: "video" });
    await hosted("Shots", 5, { kind: "upload", media_type: "image", pictures });

    expect(await sendDigests(db, mailer, input)).toBe(1);
    const { html, text } = sent[0]!;
    expect(html).toContain('<a href="https://github.com/maker/tool" style="color:#6f6b64;text-decoration:none" class="dc-6f6b64">GitHub</a> · 9 points');
    // An article's own links are its text's, not its source.
    expect(text).toContain("Essay\nArticle · 8 points");
    // The board's own address is not where an upload leads.
    expect(html).toContain('<a href="https://github.com/maker/demo" style="color:#6f6b64;text-decoration:none" class="dc-6f6b64">GitHub</a> · 7 points');
    expect(text).toContain("Clip\nVideo · 6 points");
    expect(text).toContain("Shots\nGallery · 5 points");
    expect(text).not.toMatch(/Text post|Upload/);
  });

  it("show a long description cut at a word, with a link to read the rest", async () => {
    const description = `Pick a place on a **map** and turn it into a miniature.\n\n${"Buildings, terrain, roads and water. ".repeat(10)}`;
    await post("long", { author: "maker", age: 6 * DAY, title: "A tiny town", score: 9, description });

    expect(await sendDigests(db, mailer, input)).toBe(1);
    const shown = sent[0]!.text.split("\n").find((line) => line.startsWith("Pick a place"))!;
    expect(shown).toMatch(/^Pick a place on a map and turn it into a miniature\. Buildings, .* [a-z]+…$/);
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(sent[0]!.html).toContain(`… <a href="https://aion.ly/p/long/a-tiny-town"`);
    expect(sent[0]!.html).toContain(">Read more</a>");
  });

  it("link to read the rest when the card's excerpt stops at a line, shown whole", async () => {
    const first = `Pick a place on a map and turn it into a miniature. ${"Buildings, terrain, roads and water. ".repeat(5)}`.trim();
    await post("lines", { author: "maker", age: 6 * DAY, title: "A tiny town", score: 9, description: `${first}\n\nHow it was made, step by step.` });

    expect(await sendDigests(db, mailer, input)).toBe(1);
    expect(sent[0]!.text).toContain(`\n${first}\n`);
    expect(sent[0]!.text).not.toContain("step by step");
    expect(sent[0]!.html).toContain(`water. <a href="https://aion.ly/p/lines/a-tiny-town"`);
    expect(sent[0]!.html).toContain(">Read more</a>");
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
    // Either side of the 23:00 cutoff; both exist when the first goes out.
    await post("before", { author: "maker", age: 9.5 * HOUR, title: "Made before eleven", score: 6 });
    await post("after", { author: "maker", age: 8.5 * HOUR, title: "Made after eleven", score: 8 });

    await sendDigests(db, mailer, { ...input, now: NOW + 2 * HOUR });
    expect(sent.map((email) => email.subject)).toEqual(["The past day on aion.ly: Made before eleven"]);
    expect(sent[0]!.text).not.toContain("Made after eleven");

    await sendDigests(db, mailer, { ...input, now: NOW + DAY - 90 * 60 });
    expect(sent).toHaveLength(1);
    await sendDigests(db, mailer, { ...input, now: NOW + DAY });
    expect(sent.map((email) => email.subject)).toEqual([
      "The past day on aion.ly: Made before eleven",
      "The past day on aion.ly: Made after eleven",
    ]);
    expect(sent[1]!.text).not.toContain("Made before eleven");
  });
});

describe("the daily digest", () => {
  it("brings the weekly and monthly ones, and the weekly one the monthly, never two at once", async () => {
    await member("weekly", "week_reader");
    await member("monthly", "month_reader");
    await setDigest(db, "reader", "daily", NOW - 60 * DAY);
    await setDigest(db, "weekly", "weekly", NOW - 60 * DAY);
    await setDigest(db, "monthly", "monthly", NOW - 60 * DAY);
    await post("day", { author: "maker", age: DAY, title: "Of the day", score: 5 });
    await post("week", { author: "maker", age: 6 * DAY, title: "Of the week", score: 5 });
    await post("month", { author: "maker", age: 20 * DAY, title: "Of December", score: 5 });

    // All three are due now, but each account gets one digest at a time,
    // the next once 6 hours have passed.
    const got = (to: string) => sent.filter((email) => email.to === `${to}@example.invalid`).map((email) => email.subject);
    expect(await sendDigests(db, mailer, input)).toBe(3);
    expect(got("reader")).toEqual(["The past day on aion.ly: Of the day"]);
    expect(got("weekly")).toEqual(["Last week on aion.ly: Of the week"]);
    expect(got("monthly")).toEqual(["December on aion.ly: Of December"]);
    expect(await sendDigests(db, mailer, { ...input, now: NOW + 3 * HOUR })).toBe(0);
    expect(await sendDigests(db, mailer, { ...input, now: NOW + 6 * HOUR })).toBe(2);
    expect(await sendDigests(db, mailer, { ...input, now: NOW + 12 * HOUR })).toBe(1);
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
    // The month's is still due, once 6 hours have passed since the choice
    // counted as a digest; today's and this week's come with their next periods.
    expect(await dueRecipients(db, "monthly", NOW)).toEqual([]);
    expect((await dueRecipients(db, "monthly", NOW + 6 * HOUR)).map((row) => row.userId)).toEqual(["reader"]);
    expect(await dueRecipients(db, "weekly", NOW + 6 * HOUR)).toEqual([]);
    expect(await dueRecipients(db, "daily", NOW + 6 * HOUR)).toEqual([]);
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

  it("goes with the most discussed alone, when nothing is most voted (review F82)", async () => {
    await post("talked", { author: "maker", age: 2 * DAY, title: "Talked about", score: 2 });
    await discuss("talked", "reader", 5);
    expect(await sendTestDigest(db, mailer, test)).toBeNull();
    expect(sent[0]?.subject).toBe("[Test] The past week on aion.ly: Talked about");
  });
});
