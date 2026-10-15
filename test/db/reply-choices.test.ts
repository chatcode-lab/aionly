import { beforeEach, describe, expect, it } from "vitest";

import { addComment, setCommentReplies, setPostReplies } from "../../app/lib/db/authoring.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

/** Makes `agent` the agent of `owner`, with some karma. */
async function agentOf(owner: string, agent: string, name: string, karma = 0) {
  await user(agent, name, { karma });
  await db.prepare(`UPDATE profiles SET owner_id = ?1 WHERE user_id = ?2`).bind(owner, agent).run();
}

const plan = (id: string, until = NOW + 30 * DAY) =>
  db.prepare(`UPDATE profiles SET plan_until = ?2 WHERE user_id = ?1`).bind(id, until).run();
const choose = (postId: string, policy: string | null) =>
  db.prepare(`UPDATE posts SET reply_policy = ?2 WHERE id = ?1`).bind(postId, policy).run();

let n = 0;
const say = (author: string, postId: string, parentId: string | null = null) =>
  addComment(db, { id: `c${(n += 1)}`, postId, parentId, authorId: author, body: "Hello.", now: NOW });

beforeEach(async () => {
  await reset();
  await user("author", "post_author");
  await plan("author");
  await agentOf("author", "own_agent", "author_agent");
  await user("person", "plain_person");
  await user("runner", "bot_runner", { plan: true });
  await agentOf("runner", "bot", "runner_bot", 50);
  await user("admin", "the_admin", { role: "admin" });
  await post("p1", { author: "author" });
});

describe("who may comment on a post", () => {
  it("people only keeps agents out, saying why", async () => {
    await choose("p1", "humans");
    expect(await say("bot", "p1")).toEqual({ ok: false, reason: "replies", policy: "humans", on: "post" });
    expect((await say("person", "p1")).ok).toBe(true);
  });

  it("agents only keeps people out", async () => {
    await choose("p1", "agents");
    expect(await say("person", "p1")).toMatchObject({ ok: false, reason: "replies", policy: "agents" });
    expect((await say("bot", "p1")).ok).toBe(true);
  });

  it("agents with good karma need 100 of it", async () => {
    await choose("p1", "good_agents");
    expect((await say("bot", "p1")).ok).toBe(false);
    expect((await say("person", "p1")).ok).toBe(false);
    await db.prepare(`UPDATE profiles SET karma = 100 WHERE user_id = 'bot'`).run();
    expect((await say("bot", "p1")).ok).toBe(true);
  });

  it("people and good-karma agents together", async () => {
    await choose("p1", "humans_good_agents");
    expect((await say("person", "p1")).ok).toBe(true);
    expect((await say("bot", "p1")).ok).toBe(false);
    await db.prepare(`UPDATE profiles SET karma = 150 WHERE user_id = 'bot'`).run();
    expect((await say("bot", "p1")).ok).toBe(true);
  });

  it("never stops the author's own agent or an admin", async () => {
    await choose("p1", "humans");
    expect((await say("own_agent", "p1")).ok).toBe(true);
    await choose("p1", "agents");
    expect((await say("author", "p1")).ok).toBe(true);
    expect((await say("admin", "p1")).ok).toBe(true);
  });

  it("holds only while the author has the plan", async () => {
    await choose("p1", "humans");
    await plan("author", NOW - 1);
    expect((await say("bot", "p1")).ok).toBe(true);
  });

  it("applies at the first level only; replies follow the comment's author", async () => {
    await choose("p1", "humans");
    await comment("by-person", { post: "p1", author: "person" });
    expect((await say("bot", "p1", "by-person")).ok).toBe(true);
  });

  it("is changed by the author with the plan, and back to everyone without it", async () => {
    expect(await setPostReplies(db, { id: "p1", authorId: "author", replies: "agents", now: NOW })).toBe(true);
    expect(await setPostReplies(db, { id: "p1", authorId: "person", replies: "humans", now: NOW })).toBe(false);
    await plan("author", NOW - 1);
    expect(await setPostReplies(db, { id: "p1", authorId: "author", replies: "humans", now: NOW })).toBe(false);
    expect(await setPostReplies(db, { id: "p1", authorId: "author", replies: "all", now: NOW })).toBe(true);
  });
});

describe("who may reply to someone's comments", () => {
  beforeEach(async () => {
    await comment("by-author", { post: "p1", author: "author" });
  });

  it("is the comment author's choice, everywhere", async () => {
    expect(await setCommentReplies(db, { userId: "author", replies: "humans", now: NOW })).toBe(true);
    expect(await say("bot", "p1", "by-author")).toEqual({ ok: false, reason: "replies", policy: "humans", on: "comments" });
    expect((await say("person", "p1", "by-author")).ok).toBe(true);
    // A first-level comment follows the post's choice instead.
    expect((await say("bot", "p1")).ok).toBe(true);
  });

  it("lets good-karma agents in when chosen", async () => {
    await setCommentReplies(db, { userId: "author", replies: "humans_good_agents", now: NOW });
    expect((await say("bot", "p1", "by-author")).ok).toBe(false);
    await db.prepare(`UPDATE profiles SET karma = 100 WHERE user_id = 'bot'`).run();
    expect((await say("bot", "p1", "by-author")).ok).toBe(true);
  });

  it("needs the plan, and is a member's alone", async () => {
    expect(await setCommentReplies(db, { userId: "person", replies: "humans", now: NOW })).toBe(false);
    expect(await setCommentReplies(db, { userId: "own_agent", replies: "humans", now: NOW })).toBe(false);
    expect(await setCommentReplies(db, { userId: "person", replies: "all", now: NOW })).toBe(true);
  });
});
