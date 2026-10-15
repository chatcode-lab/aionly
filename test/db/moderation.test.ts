import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord, participantCondition } from "../../app/lib/db/accounts.server";
import { addComment } from "../../app/lib/db/authoring.server";
import {
  activeRemoval,
  banPreview,
  banUser,
  removeComment,
  removePost,
  revertAction,
  unbanUser,
} from "../../app/lib/db/moderation.server";
import { announcement, pinAnnouncement, unpinAnnouncement } from "../../app/lib/db/pins.server";
import { dismissReports, fileReport, openReportCount, reportQueue } from "../../app/lib/db/reports.server";
import { castVote } from "../../app/lib/db/votes.server";
import { REPORTS_PER_DAY } from "../../app/lib/reports";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("admin", "the_admin", { role: "admin" });
  await user("u1", "author");
  await user("u2", "voter");
  await user("u3", "bystander");
  await post("p1", { author: "u1" });
  await comment("c1", { post: "p1", author: "u1" });
});

const score = async (table: "posts" | "comments", id: string) =>
  (await db.prepare(`SELECT score FROM ${table} WHERE id = ?1`).bind(id).first<{ score: number }>())!.score;
const karma = async (id: string) =>
  (await db.prepare(`SELECT karma FROM profiles WHERE user_id = ?1`).bind(id).first<{ karma: number }>())!.karma;
const removed = async (table: "posts" | "comments", id: string) =>
  (await db.prepare(`SELECT removed_batch_id FROM ${table} WHERE id = ?1`).bind(id).first<{ removed_batch_id: string | null }>())!
    .removed_batch_id;
const canTakePart = async (id: string, now = NOW) =>
  Boolean(await db.prepare(`SELECT ${participantCondition(1, now)} AS ok`).bind(id).first<{ ok: number }>().then((row) => row?.ok));

describe("removal", () => {
  it("removes a post, closes its reports, and restores it exactly", async () => {
    await fileReport(db, { id: "r1", reporterId: "u2", type: "post", targetId: "p1", reason: "spam", note: null, now: NOW });
    const result = await removePost(db, { postId: "p1", actorId: "admin", reason: "spam", now: NOW });
    expect(result.ok).toBe(true);
    expect(await removed("posts", "p1")).not.toBeNull();
    expect(await openReportCount(db)).toBe(0);
    expect(await removePost(db, { postId: "p1", actorId: "admin", reason: null, now: NOW })).toEqual({ ok: false, reason: "already" });

    const action = await activeRemoval(db, "post", "p1");
    expect(action).toBe(result.ok ? result.actionId : null);
    expect((await revertAction(db, { actionId: action!, actorId: "admin", now: NOW })).ok).toBe(true);
    expect(await removed("posts", "p1")).toBeNull();
    // Undone once; a second undo finds nothing to do.
    expect(await revertAction(db, { actionId: action!, actorId: "admin", now: NOW })).toEqual({ ok: false, reason: "not_found" });
  });

  it("cannot remove what its author already deleted", async () => {
    await post("gone", { author: "u1", deleted: true });
    expect(await removePost(db, { postId: "gone", actorId: "admin", reason: null, now: NOW })).toEqual({ ok: false, reason: "already" });
    expect(await removePost(db, { postId: "missing", actorId: "admin", reason: null, now: NOW })).toEqual({ ok: false, reason: "not_found" });
  });

  it("removes one comment in place and undoes only that", async () => {
    const result = await removeComment(db, { commentId: "c1", actorId: "admin", reason: null, now: NOW });
    expect(result.ok).toBe(true);
    expect(await removed("comments", "c1")).not.toBeNull();
    await revertAction(db, { actionId: result.ok ? result.actionId : "", actorId: "admin", now: NOW });
    expect(await removed("comments", "c1")).toBeNull();
  });
});

describe("bans", () => {
  it("makes the account and its agent read-only until a timed ban ends", async () => {
    await user("agent", "author_bot");
    await db.prepare(`UPDATE profiles SET owner_id = 'u1' WHERE user_id = 'agent'`).run();
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'u1'`).bind(NOW + 30 * DAY).run();
    const result = await banUser(db, { userId: "u1", actorId: "admin", duration: "day", reason: "Spam links", removeComments: false, discardVotes: false, now: NOW });
    expect(result.ok).toBe(true);
    expect(await canTakePart("u1")).toBe(false);
    expect(await canTakePart("agent")).toBe(false);
    expect((await accountRecord(db, "agent", NOW))?.ban).toEqual({ kind: "ban", reason: "Spam links", until: NOW + DAY });
    expect(await addComment(db, { id: "x", postId: "p1", parentId: null, authorId: "agent", body: "hi", now: NOW })).toMatchObject({ ok: false });

    // A day later it has ended by itself.
    expect(await canTakePart("u1", NOW + DAY)).toBe(true);
    expect(await canTakePart("agent", NOW + DAY)).toBe(true);
    expect((await accountRecord(db, "u1", NOW + DAY))?.ban).toBeNull();
  });

  it("never bans an admin or oneself", async () => {
    await user("admin2", "other_admin", { role: "admin" });
    const ban = (userId: string) =>
      banUser(db, { userId, actorId: "admin", duration: "permanent", reason: null, removeComments: true, discardVotes: true, now: NOW });
    expect(await ban("admin2")).toEqual({ ok: false, reason: "not_allowed" });
    expect(await ban("admin")).toEqual({ ok: false, reason: "not_allowed" });
    expect(await ban("missing")).toEqual({ ok: false, reason: "not_found" });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM mod_actions`).first()).toEqual({ n: 0 });
  });

  it("removes all their comments but keeps independent removals and deletions as they were", async () => {
    await comment("c2", { post: "p1", author: "u1" });
    await comment("c3", { post: "p1", author: "u1", deleted: true });
    await comment("reply", { post: "p1", author: "u3", parent: "c1", depth: 1 });
    const single = await removeComment(db, { commentId: "c2", actorId: "admin", reason: null, now: NOW });
    expect(await banPreview(db, "u1")).toEqual({ comments: 1, votes: 0 });

    const ban = await banUser(db, { userId: "u1", actorId: "admin", duration: "week", reason: null, removeComments: true, discardVotes: false, now: NOW });
    expect(ban.ok).toBe(true);
    expect(await removed("comments", "c1")).toBe(ban.ok ? ban.batchId : "");
    expect(await removed("comments", "reply")).toBeNull();

    const bulk = await db.prepare(`SELECT id FROM mod_actions WHERE action = 'remove_comments'`).first<{ id: string }>();
    await revertAction(db, { actionId: bulk!.id, actorId: "admin", now: NOW });
    expect(await removed("comments", "c1")).toBeNull();
    // Removed on its own, and deleted by its author: both untouched.
    expect(await removed("comments", "c2")).toBe(single.ok ? single.batchId : "");
    expect(await db.prepare(`SELECT deleted_at FROM comments WHERE id = 'c3'`).first()).toMatchObject({ deleted_at: expect.any(Number) });
  });

  it("undoes only the ban an action made, even with a later one in the same second", async () => {
    const first = await banUser(db, { userId: "u1", actorId: "admin", duration: "day", reason: "First", removeComments: false, discardVotes: false, now: NOW });
    const second = await banUser(db, { userId: "u1", actorId: "admin", duration: "permanent", reason: "Second", removeComments: false, discardVotes: false, now: NOW });
    expect(first.ok && second.ok).toBe(true);
    await revertAction(db, { actionId: first.ok ? first.actionId : "", actorId: "admin", now: NOW });
    expect((await accountRecord(db, "u1", NOW))?.ban).toEqual({ kind: "ban", reason: "Second", until: null });
    await revertAction(db, { actionId: second.ok ? second.actionId : "", actorId: "admin", now: NOW });
    expect((await accountRecord(db, "u1", NOW))?.ban).toBeNull();
  });

  it("discards their votes and restores them, each counted exactly once", async () => {
    await post("p2", { author: "u3" });
    await castVote(db, { voterId: "u2", type: "post", targetId: "p1", value: 1, now: NOW });
    await castVote(db, { voterId: "u2", type: "comment", targetId: "c1", value: 1, now: NOW });
    await castVote(db, { voterId: "u2", type: "post", targetId: "p2", value: -1, now: NOW });
    await castVote(db, { voterId: "u3", type: "post", targetId: "p1", value: 1, now: NOW });
    expect([await score("posts", "p1"), await score("comments", "c1"), await karma("u1"), await karma("u3")]).toEqual([2, 1, 3, -1]);

    const ban = await banUser(db, { userId: "u2", actorId: "admin", duration: "permanent", reason: "Vote ring", removeComments: false, discardVotes: true, now: NOW });
    expect(ban.ok).toBe(true);
    expect([await score("posts", "p1"), await score("comments", "c1"), await score("posts", "p2"), await karma("u1"), await karma("u3")]).toEqual([1, 0, 0, 1, 0]);

    const discard = await db.prepare(`SELECT id FROM mod_actions WHERE action = 'discard_votes'`).first<{ id: string }>();
    await revertAction(db, { actionId: discard!.id, actorId: "admin", now: NOW });
    await revertAction(db, { actionId: discard!.id, actorId: "admin", now: NOW });
    expect([await score("posts", "p1"), await score("comments", "c1"), await karma("u1"), await karma("u3")]).toEqual([2, 1, 3, -1]);
  });

  it("undoes a ban only while it is the one in force, and unbanning lifts any ban", async () => {
    const first = await banUser(db, { userId: "u1", actorId: "admin", duration: "day", reason: null, removeComments: false, discardVotes: false, now: NOW });
    const second = await banUser(db, { userId: "u1", actorId: "admin", duration: "week", reason: null, removeComments: false, discardVotes: false, now: NOW + 60 });
    await revertAction(db, { actionId: first.ok ? first.actionId : "", actorId: "admin", now: NOW + 120 });
    expect(await canTakePart("u1", NOW + 120)).toBe(false);
    expect(second.ok).toBe(true);
    expect((await unbanUser(db, { userId: "u1", actorId: "admin", now: NOW + 180 })).ok).toBe(true);
    expect(await canTakePart("u1", NOW + 180)).toBe(true);
    expect(await unbanUser(db, { userId: "u1", actorId: "admin", now: NOW + 240 })).toEqual({ ok: false, reason: "already" });
  });
});

describe("reports", () => {
  const report = (fields: Partial<Parameters<typeof fileReport>[1]> = {}) =>
    fileReport(db, { id: `r${Math.random()}`, reporterId: "u2", type: "comment", targetId: "c1", reason: "abuse", note: "rude", now: NOW, ...fields });

  it("keeps the reported text, one open report per reporter, and never one's own", async () => {
    expect(await report()).toEqual({ ok: true, existing: false });
    expect(await report({ reason: "spam" })).toEqual({ ok: true, existing: true });
    expect(await report({ reporterId: "u1" })).toEqual({ ok: false, reason: "own" });
    expect(await report({ targetId: "missing" })).toEqual({ ok: false, reason: "not_found" });
    await db.prepare(`UPDATE comments SET body = 'edited away' WHERE id = 'c1'`).run();
    expect(await db.prepare(`SELECT snapshot FROM reports`).first()).toEqual({ snapshot: "Body of c1" });
  });

  it("groups the queue by target, and dismissing closes them", async () => {
    await report();
    await report({ reporterId: "u3", reason: "spam", note: null });
    await report({ reporterId: "u3", type: "user", targetId: "u1", reason: "spam", note: null });
    const queue = await reportQueue(db);
    expect(queue).toHaveLength(2);
    const onComment = queue.find((item) => item.type === "comment")!;
    expect(onComment).toMatchObject({ count: 2, reasons: { abuse: 1, spam: 1 }, notes: ["rude"], author: { id: "u1", username: "author" }, state: "live" });
    expect(onComment.link).toBe("/p/p1/title-of-p1?c=c1#c-c1");
    expect(await dismissReports(db, { type: "comment", id: "c1", actorId: "admin", now: NOW })).toBe(2);
    expect(await openReportCount(db)).toBe(1);
  });

  it("refuses a banned reporter and stops at the daily ceiling", async () => {
    await banUser(db, { userId: "u3", actorId: "admin", duration: "day", reason: null, removeComments: false, discardVotes: false, now: NOW });
    expect(await report({ reporterId: "u3" })).toEqual({ ok: false, reason: "not_allowed" });
    await db.batch(
      Array.from({ length: REPORTS_PER_DAY }, (_, index) =>
        db
          .prepare(`INSERT INTO reports (id, reporter_id, target_type, target_id, reason, status, created_at) VALUES (?1, 'u2', 'post', ?2, 'spam', 'resolved', ?3)`)
          .bind(`old${index}`, `x${index}`, NOW - 60),
      ),
    );
    expect(await report()).toEqual({ ok: false, reason: "limit" });
  });
});

describe("pins", () => {
  it("pins a live post as the announcement, replaces it, and hides it once removed", async () => {
    await post("p2", { author: "u3", title: "Second" });
    expect(await pinAnnouncement(db, { postId: "p1", actorId: "admin", note: "Welcome", now: NOW })).toBe(true);
    expect(await announcement(db)).toMatchObject({ post: { id: "p1" }, note: "Welcome" });
    await pinAnnouncement(db, { postId: "p2", actorId: "admin", note: null, now: NOW + 1 });
    expect((await announcement(db))?.post.id).toBe("p2");
    await removePost(db, { postId: "p2", actorId: "admin", reason: null, now: NOW + 2 });
    expect(await announcement(db)).toBeNull();
    expect(await unpinAnnouncement(db, { actorId: "admin", now: NOW + 3 })).toBe(true);
    expect(await pinAnnouncement(db, { postId: "p2", actorId: "admin", note: null, now: NOW + 4 })).toBe(false);
  });
});
