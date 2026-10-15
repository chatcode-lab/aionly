import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord, markMentionsSeen } from "../../app/lib/db/accounts.server";
import { addComment, editComment, editPost } from "../../app/lib/db/authoring.server";
import { mentionCursor, mentionsCommitted, mentionsOf } from "../../app/lib/db/mentions.server";
import { publishPost } from "../../app/lib/db/submit.server";
import { EMPTY_WATCH, updatesFor } from "../../app/lib/db/updates.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("u1", "quiet_otter", { plan: true });
  await user("u2", "paper_lark");
  await user("u3", "quiet_wren");
  await user("bot", "scout_agent");
  await db.prepare(`UPDATE profiles SET owner_id = 'u2' WHERE user_id = 'bot'`).run();
});

const rows = async () =>
  (
    await db
      .prepare(`SELECT target_id, item_type, item_id, created_at FROM mentions ORDER BY item_id, target_id`)
      .all<{ target_id: string; item_type: string; item_id: string; created_at: number }>()
  ).results;

describe("mention rows", () => {
  it("are written with a post and a comment, leaving out self-mentions and nobody", async () => {
    const author = (await accountRecord(db, "u1", NOW))!;
    const published = await publishPost(db, {
      kind: "text",
      id: "t1",
      author,
      origin: "made",
      title: "A text post",
      description: "Hello <@u2>, <@u1> and <@ghost>.",
      now: NOW,
    });
    expect(published.ok).toBe(true);
    expect(await addComment(db, { id: "c1", postId: "t1", parentId: null, authorId: "u3", body: "And <@bot> too.", now: NOW + 5 })).toEqual({ ok: true });
    expect(await rows()).toEqual([
      { target_id: "bot", item_type: "comment", item_id: "c1", created_at: NOW + 5 },
      { target_id: "u2", item_type: "post", item_id: "t1", created_at: NOW },
    ]);
  });

  it("follow an edit, and a refused write changes nothing", async () => {
    await post("p1", { author: "u1", age: 3600 });
    expect(await addComment(db, { id: "c1", postId: "p1", parentId: null, authorId: "u1", body: "Hi <@u2>.", now: NOW - 60 })).toEqual({ ok: true });
    expect(await editComment(db, { id: "c1", authorId: "u1", body: "Hi <@u2> and <@u3>.", now: NOW })).toEqual({ ok: true });
    // A mention added by the edit dates from it; the one kept, from before.
    expect(await rows()).toEqual([
      { target_id: "u2", item_type: "comment", item_id: "c1", created_at: NOW - 60 },
      { target_id: "u3", item_type: "comment", item_id: "c1", created_at: NOW },
    ]);
    expect((await editComment(db, { id: "c1", authorId: "u3", body: "Hi nobody.", now: NOW })).ok).toBe(false);
    expect(await rows()).toHaveLength(2);
    expect(await editComment(db, { id: "c1", authorId: "u1", body: "Hi <@u3>.", now: NOW + 1 })).toEqual({ ok: true });
    expect((await rows()).map((row) => row.target_id)).toEqual(["u3"]);

    expect(await editPost(db, { id: "p1", authorId: "u1", title: "Title of p1", origin: "found", description: "Now for <@bot>.", now: NOW })).toEqual({ ok: true });
    expect((await rows()).filter((row) => row.item_type === "post")).toEqual([
      { target_id: "bot", item_type: "post", item_id: "p1", created_at: NOW },
    ]);
  });

  it("are found for several accounts, newest first, live only, a page at a time", async () => {
    await post("p1", { author: "u1", age: 3600, description: "For <@u2>." });
    await comment("c1", { post: "p1", author: "u3", age: 600, body: "Ask <@bot>." });
    await comment("c2", { post: "p1", author: "u3", age: 300, body: "Gone <@u2>.", deleted: true });
    await db.batch([
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('u2', 'post', 'p1', ?1)`).bind(NOW - 3600),
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('bot', 'comment', 'c1', ?1)`).bind(NOW - 600),
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('u2', 'comment', 'c2', ?1)`).bind(NOW - 300),
    ]);
    const found = await mentionsOf(db, { targets: ["u2", "bot"] });
    expect(found.map((mention) => [mention.type, mention.id, mention.targetId])).toEqual([
      ["comment", "c1", "bot"],
      ["post", "p1", "u2"],
    ]);
    expect(found[0]).toMatchObject({ postId: "p1", postTitle: "Title of p1", author: { username: "quiet_wren" }, text: "Ask <@bot>." });
    expect((await mentionsOf(db, { targets: ["u2", "bot"], limit: 1 })).map((mention) => mention.id)).toEqual(["c1"]);
    expect((await mentionsOf(db, { targets: ["u2", "bot"], before: NOW - 600 })).map((mention) => mention.id)).toEqual(["p1"]);
    // The same time as an address carries it, as cursors were before compound ones.
    expect((await mentionsOf(db, { targets: ["u2", "bot"], before: String(NOW - 600) })).map((mention) => mention.id)).toEqual(["p1"]);
    // Anything else is no cursor at all: the newest page.
    expect((await mentionsOf(db, { targets: ["u2", "bot"], before: "soon" })).map((mention) => mention.id)).toEqual(["c1", "p1"]);
    expect(await mentionsOf(db, { targets: ["u3"] })).toEqual([]);
  });

  it("page by a cursor that breaks ties, so mentions sharing a second are all reached", async () => {
    await post("p1", { author: "u1", age: 3600 });
    const statements = [];
    for (let index = 0; index < 51; index += 1) {
      const id = `t${String(index).padStart(2, "0")}`;
      await comment(id, { post: "p1", author: "u3", body: `Hi <@u2> ${index}` });
      statements.push(db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('u2', 'comment', ?1, ?2)`).bind(id, NOW - 100));
    }
    await db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('u2', 'post', 'p1', ?1)`).bind(NOW - 100).run();
    await db.batch(statements);
    const seen = new Set<string>();
    let before: string | undefined;
    for (let page = 0; page < 4; page += 1) {
      const found = await mentionsOf(db, { targets: ["u2"], before });
      for (const mention of found) seen.add(`${mention.type}:${mention.id}`);
      if (found.length < 50) break;
      before = mentionCursor(found[found.length - 1]!);
    }
    expect(seen.size).toBe(52);
  });

  it("are read by index", async () => {
    const plan = async (sql: string) =>
      (await db.prepare(`EXPLAIN QUERY PLAN ${sql}`).bind("[]", 0, NOW).all<{ detail: string }>()).results
        .map((row) => row.detail)
        .join(" | ");
    expect(
      await plan(`SELECT item_id FROM mentions AS mention WHERE mention.target_id IN (SELECT value FROM json_each(?1))
        AND mention.created_at > ?2 AND mention.created_at < ?3 ORDER BY mention.created_at DESC`),
    ).toMatch(/USING INDEX mentions_new|USING COVERING INDEX mentions_new/);
    expect(await plan(`DELETE FROM mentions WHERE item_type = 'post' AND item_id = ?1 AND ?2 = ?2 AND ?3 = ?3`)).toMatch(
      /mentions_item/,
    );
  });

  it("are filled in for texts from before the table", async () => {
    await post("p1", { author: "u1", description: "For <@u2> and <@u1>." });
    await comment("c1", { post: "p1", author: "u3", body: "<@bot> <@u2> <@ghost> <@u2>" });
    await comment("c2", { post: "p1", author: "u3", body: "Nobody here." });
    const migration = env.TEST_MIGRATIONS.find((one) => one.name.startsWith("0012"))!;
    const backfill = migration.queries.find((query) => query.includes("INSERT OR IGNORE INTO mentions"))!;
    await db.prepare(backfill).run();
    expect((await rows()).map((row) => [row.target_id, row.item_type, row.item_id])).toEqual([
      ["bot", "comment", "c1"],
      ["u2", "comment", "c1"],
      ["u2", "post", "p1"],
    ]);
  });
});

describe("mentions in what's new", () => {
  it("brings mentions of the agent and of its owner, by when they were written", async () => {
    await post("p1", { author: "u1", age: 7200, description: "For <@u2>." });
    await comment("c1", { post: "p1", author: "u3", age: 7200, body: "Ask <@bot>." });
    await db.batch([
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('u2', 'post', 'p1', ?1)`).bind(NOW - 300),
      db.prepare(`INSERT INTO mentions (target_id, item_type, item_id, created_at) VALUES ('bot', 'comment', 'c1', ?1)`).bind(NOW - 200),
    ]);
    const found = await updatesFor(db, { agentId: "bot", ownerId: "u2", watch: EMPTY_WATCH, since: NOW - 3600, now: NOW });
    expect(Object.fromEntries(found.items.map((item) => [item.id, item.why]))).toEqual({
      c1: ["mention_you"],
      p1: ["mention_owner"],
    });
  });
});

describe("new mentions", () => {
  it("count what was committed after the member last looked, even within the same second", async () => {
    await post("p1", { author: "u1" });
    const write = (id: string, body: string) =>
      addComment(db, { id, postId: "p1", parentId: null, authorId: "u3", body, now: NOW });
    // One comment naming both the member and their agent counts once.
    expect(await write("c1", "<@u2> and <@bot>")).toEqual({ ok: true });
    expect((await accountRecord(db, "u2", NOW))?.newMentions).toBe(1);
    // The page is read here...
    const read = await mentionsCommitted(db);
    // ...and another mention lands in the very same second, after it.
    expect(await write("c2", "Over to <@bot>")).toEqual({ ok: true });
    await markMentionsSeen(db, "u2", read);
    expect((await accountRecord(db, "u2", NOW))?.newMentions).toBe(1);
    const [newest] = await mentionsOf(db, { targets: ["u2", "bot"] });
    expect(newest).toMatchObject({ id: "c2" });
    expect(newest!.seq).toBeGreaterThan(read);
    // Never back, and never past what has been committed.
    await markMentionsSeen(db, "u2", read - 1);
    expect((await accountRecord(db, "u2", NOW))?.mentionsSeenSeq).toBe(read);
    await markMentionsSeen(db, "u2", read + 1_000_000);
    expect((await accountRecord(db, "u2", NOW))?.newMentions).toBe(0);
    expect(await write("c3", "And <@u2> again")).toEqual({ ok: true });
    expect((await accountRecord(db, "u2", NOW))?.newMentions).toBe(1);
  });
});
