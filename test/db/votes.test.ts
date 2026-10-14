import { beforeEach, describe, expect, it } from "vitest";

import { savedAmong, savedPosts, setSaved } from "../../app/lib/db/bookmarks.server";
import { castVote, votesOn } from "../../app/lib/db/votes.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("author", "quiet_otter_482");
  await user("v1", "paper_lark_17");
  await user("v2", "amber_moth_905");
  await post("p1", { author: "author" });
  await comment("c1", { post: "p1", author: "author" });
});

const vote = (voterId: string, targetId: string, value: -1 | 0 | 1, type: "post" | "comment" = "post") =>
  castVote(db, { voterId, type, targetId, value, now: NOW });

async function karma(userId: string): Promise<number | undefined> {
  return (await db.prepare(`SELECT karma FROM profiles WHERE user_id = ?1`).bind(userId).first<{ karma: number }>())?.karma;
}

describe("castVote", () => {
  it("counts a vote once, and changing or clearing it moves the score and karma exactly", async () => {
    expect(await vote("v1", "p1", 1)).toEqual({ ok: true, score: 1, vote: 1 });
    expect(await vote("v1", "p1", 1)).toEqual({ ok: true, score: 1, vote: 1 });
    expect(await vote("v2", "p1", 1)).toEqual({ ok: true, score: 2, vote: 1 });
    expect(await karma("author")).toBe(2);

    expect(await vote("v1", "p1", -1)).toEqual({ ok: true, score: 0, vote: -1 });
    expect(await vote("v2", "p1", 0)).toEqual({ ok: true, score: -1, vote: 0 });
    expect(await karma("author")).toBe(-1);
    // Clearing a vote that is not there changes nothing and is not an error.
    expect(await vote("v2", "p1", 0)).toEqual({ ok: true, score: -1, vote: 0 });
  });

  it("adds comment votes to the same karma", async () => {
    await vote("v1", "p1", 1);
    expect(await vote("v1", "c1", 1, "comment")).toEqual({ ok: true, score: 1, vote: 1 });
    expect(await vote("v2", "c1", 1, "comment")).toEqual({ ok: true, score: 2, vote: 1 });
    expect(await karma("author")).toBe(3);
  });

  it("refuses votes on one's own items", async () => {
    expect(await vote("author", "p1", 1)).toEqual({ ok: false, reason: "own" });
    expect(await vote("author", "c1", 1, "comment")).toEqual({ ok: false, reason: "own" });
    expect(await karma("author")).toBe(0);
  });

  it("refuses votes on removed or deleted items, and on comments under them", async () => {
    await post("gone", { author: "author", removed: true });
    await post("deleted", { author: "author", deleted: true });
    await comment("c_under", { post: "gone", author: "author" });
    await comment("c_removed", { post: "p1", author: "author", removed: true });
    expect(await vote("v1", "gone", 1)).toEqual({ ok: false, reason: "closed" });
    expect(await vote("v1", "deleted", 1)).toEqual({ ok: false, reason: "closed" });
    expect(await vote("v1", "c_under", 1, "comment")).toEqual({ ok: false, reason: "closed" });
    expect(await vote("v1", "c_removed", 1, "comment")).toEqual({ ok: false, reason: "closed" });
    expect(await vote("v1", "missing", 1)).toEqual({ ok: false, reason: "not_found" });
  });

  it("keeps the votes a removed item already had", async () => {
    await vote("v1", "p1", 1);
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1' WHERE id = 'p1'`).run();
    expect(await vote("v1", "p1", 0)).toEqual({ ok: false, reason: "closed" });
    expect(await karma("author")).toBe(1);
  });

  it("refuses banned accounts and agents inside the write", async () => {
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'v1'`).bind(NOW).run();
    expect(await vote("v1", "p1", 1)).toEqual({ ok: false, reason: "not_allowed" });
    await db.prepare(`UPDATE profiles SET owner_id = 'v1' WHERE user_id = 'v2'`).run();
    expect(await vote("v2", "p1", 1)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await karma("author")).toBe(0);
  });

  it("lets a timed ban end by itself", async () => {
    await db
      .prepare(`UPDATE profiles SET banned_at = ?1, banned_until = ?2 WHERE user_id = 'v1'`)
      .bind(NOW - 100, NOW)
      .run();
    expect(await vote("v1", "p1", 1)).toEqual({ ok: true, score: 1, vote: 1 });
  });

  it("leaves out votes discarded by a ban", async () => {
    await vote("v1", "p1", 1);
    await vote("v2", "p1", 1);
    await db.prepare(`UPDATE votes SET invalidated_batch_id = 'b1' WHERE voter_id = 'v1'`).run();
    // The next change recomputes from the votes that count.
    await vote("v2", "p1", -1);
    const row = await db.prepare(`SELECT score FROM posts WHERE id = 'p1'`).first<{ score: number }>();
    expect(row?.score).toBe(-1);
    expect(await karma("author")).toBe(-1);
  });

  it("repairs a drifted cached score with the next vote", async () => {
    await db.prepare(`UPDATE posts SET score = 999 WHERE id = 'p1'`).run();
    expect(await vote("v1", "p1", 1)).toEqual({ ok: true, score: 1, vote: 1 });
  });
});

describe("votesOn", () => {
  it("returns the account's own votes for the asked items, past D1's parameter limit", async () => {
    await vote("v1", "p1", 1);
    await vote("v1", "c1", -1, "comment");
    const many = [...Array.from({ length: 300 }, (_, n) => `x${n}`), "p1"];
    expect(await votesOn(db, "v1", "post", many)).toEqual({ p1: 1 });
    expect(await votesOn(db, "v1", "comment", ["c1"])).toEqual({ c1: -1 });
    expect(await votesOn(db, "v2", "post", ["p1"])).toEqual({});
  });
});

describe("bookmarks", () => {
  it("saves and unsaves, newest saved first, privately", async () => {
    await post("p2", { author: "author" });
    expect(await setSaved(db, { userId: "v1", postId: "p1", saved: true, now: NOW })).toBe(true);
    expect(await setSaved(db, { userId: "v1", postId: "p2", saved: true, now: NOW + 1 })).toBe(true);
    expect((await savedPosts(db, "v1")).map((entry) => entry.state === "live" && entry.post.id)).toEqual(["p2", "p1"]);
    expect(await savedPosts(db, "v2")).toEqual([]);
    expect(await savedAmong(db, "v1", ["p1", "x"])).toEqual(["p1"]);

    expect(await setSaved(db, { userId: "v1", postId: "p2", saved: false, now: NOW })).toBe(true);
    expect(await savedAmong(db, "v1", ["p1", "p2"])).toEqual(["p1"]);
  });

  it("keeps a removed post as a tombstone that can be unsaved, but not saved anew", async () => {
    await setSaved(db, { userId: "v1", postId: "p1", saved: true, now: NOW });
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1' WHERE id = 'p1'`).run();
    const [entry] = await savedPosts(db, "v1");
    expect(entry).toEqual({ state: "removed", savedAt: NOW, postId: "p1" });
    expect(JSON.stringify(entry)).not.toContain("Title of p1");

    expect(await setSaved(db, { userId: "v2", postId: "p1", saved: true, now: NOW })).toBe(false);
    expect(await setSaved(db, { userId: "v1", postId: "p1", saved: false, now: NOW })).toBe(true);
    expect(await savedPosts(db, "v1")).toEqual([]);
  });

  it("refuses a banned account", async () => {
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'v1'`).bind(NOW).run();
    expect(await setSaved(db, { userId: "v1", postId: "p1", saved: true, now: NOW })).toBe(false);
  });
});
