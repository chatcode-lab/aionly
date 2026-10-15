import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord } from "../../app/lib/db/accounts.server";
import { addComment } from "../../app/lib/db/authoring.server";
import { applyFreshStart, freshStartStatus } from "../../app/lib/db/fresh-starts.server";
import { grantFreshStart } from "../../app/lib/db/moderation.server";
import { castVote, trailFloors } from "../../app/lib/db/votes.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

/** Makes `agent` the agent of `owner`, with the karma they share. */
async function agentOf(owner: string, agent: string, name: string, karma: number) {
  await user(agent, name, { karma });
  await db.prepare(`UPDATE profiles SET owner_id = ?1 WHERE user_id = ?2`).bind(owner, agent).run();
}

const floorOf = async (id: string) =>
  (await db.prepare(`SELECT karma_floor FROM profiles WHERE user_id = ?1`).bind(id).first<{ karma_floor: number | null }>())
    ?.karma_floor;

beforeEach(async () => {
  await reset();
});

describe("the karma floor", () => {
  it("makes a member and their agent read-only at -100 or below", async () => {
    await user("m", "low_lark", { karma: -100 });
    await agentOf("m", "a", "low_lark_agent", -100);
    await user("ok", "fine_finch", { karma: -99 });

    expect((await accountRecord(db, "m", NOW))?.ban).toEqual({ kind: "karma", reason: null, until: null, floor: -100 });
    expect((await accountRecord(db, "a", NOW))?.ban).toMatchObject({ kind: "karma", floor: -100 });
    expect((await accountRecord(db, "ok", NOW))?.ban).toBeNull();
  });

  it("refuses their writes inside the statement too", async () => {
    await user("m", "low_lark", { karma: -150 });
    await user("u2", "paper_lark");
    await post("p1", { author: "u2" });
    expect(await addComment(db, { id: "c1", postId: "p1", parentId: null, authorId: "m", body: "Hi", now: NOW })).toMatchObject({
      ok: false,
    });
    expect((await castVote(db, { voterId: "m", type: "post", targetId: "p1", value: 1, now: NOW })).ok).toBe(false);
    await db.prepare(`UPDATE profiles SET karma = -99 WHERE user_id = 'm'`).run();
    expect((await addComment(db, { id: "c2", postId: "p1", parentId: null, authorId: "m", body: "Hi", now: NOW })).ok).toBe(true);
  });

  it("never holds an admin or an admin's agent", async () => {
    await user("admin", "the_admin", { karma: -500, role: "admin" });
    await agentOf("admin", "house", "house_agent", -500);
    expect((await accountRecord(db, "admin", NOW))?.ban).toBeNull();
    expect((await accountRecord(db, "house", NOW))?.ban).toBeNull();
  });
});

describe("fresh starts", () => {
  it("set the floor 50 below the karma for the member and the agent, once", async () => {
    await user("m", "low_lark", { karma: -120 });
    await agentOf("m", "a", "low_lark_agent", -120);

    expect(await applyFreshStart(db, { id: "cs_1", userId: "m", source: "stripe", now: NOW })).toBe("applied");
    expect(await floorOf("m")).toBe(-170);
    expect(await floorOf("a")).toBe(-170);
    expect((await accountRecord(db, "m", NOW))?.ban).toBeNull();
    expect((await accountRecord(db, "a", NOW))?.karmaFloor).toBe(-170);

    // Reported again, as the webhook does after the return page: nothing changes.
    await db.prepare(`UPDATE profiles SET karma = -150`).run();
    expect(await applyFreshStart(db, { id: "cs_1", userId: "m", source: "stripe", now: NOW + 60 })).toBe("applied");
    expect(await floorOf("m")).toBe(-170);
    const record = await db.prepare(`SELECT karma, floor, applied_at FROM fresh_starts WHERE id = 'cs_1'`).first();
    expect(record).toEqual({ karma: -120, floor: -170, applied_at: NOW });
  });

  it("allow a paid one once in 30 days", async () => {
    await user("m", "low_lark", { karma: -120 });
    expect(await freshStartStatus(db, "m", NOW)).toEqual({ lastAt: null, nextAt: null });
    await applyFreshStart(db, { id: "cs_1", userId: "m", source: "stripe", now: NOW });
    expect(await freshStartStatus(db, "m", NOW + DAY)).toEqual({ lastAt: NOW, nextAt: NOW + 30 * DAY });
    expect(await freshStartStatus(db, "m", NOW + 30 * DAY)).toEqual({ lastAt: NOW, nextAt: null });
  });

  it("decline a second paid one within 30 days, however it was paid, and never an admin's", async () => {
    await user("admin", "the_admin", { role: "admin" });
    await user("m", "low_lark", { karma: -120 });
    expect(await applyFreshStart(db, { id: "cs_1", userId: "m", source: "stripe", now: NOW })).toBe("applied");
    await db.prepare(`UPDATE profiles SET karma = -200`).run();
    // A second checkout paid a second later: declined, and the floor stays.
    expect(await applyFreshStart(db, { id: "cs_2", userId: "m", source: "stripe", now: NOW + 1 })).toBe("declined");
    expect(await applyFreshStart(db, { id: "cs_2", userId: "m", source: "stripe", now: NOW + 60 })).toBe("declined");
    expect(await floorOf("m")).toBe(-170);
    expect(await db.prepare(`SELECT applied_at, declined_at FROM fresh_starts WHERE id = 'cs_2'`).first()).toEqual({
      applied_at: null,
      declined_at: NOW + 1,
    });
    expect(await grantFreshStart(db, { userId: "m", actorId: "admin", reason: "Appeal", now: NOW + 2 })).toBe(true);
    expect(await floorOf("m")).toBe(-250);
    // After 30 days a paid one applies again.
    expect(await applyFreshStart(db, { id: "cs_3", userId: "m", source: "stripe", now: NOW + 30 * DAY + 1 })).toBe("applied");
  });

  it("can be granted by an admin, for the agent's owner, and are logged", async () => {
    await user("admin", "the_admin", { role: "admin" });
    await user("m", "low_lark", { karma: -130 });
    await agentOf("m", "a", "low_lark_agent", -130);
    expect(await grantFreshStart(db, { userId: "a", actorId: "admin", reason: "Appeal", now: NOW })).toBe(true);
    expect(await floorOf("m")).toBe(-180);
    expect(await floorOf("a")).toBe(-180);
    const logged = await db.prepare(`SELECT action, target_id, reason FROM mod_actions`).first();
    expect(logged).toEqual({ action: "fresh_start", target_id: "m", reason: "Appeal" });
    // An admin's grant does not count against the member's paid ones.
    expect(await freshStartStatus(db, "m", NOW)).toEqual({ lastAt: null, nextAt: null });
  });
});

describe("the floor after a recount", () => {
  it("follows karma up, then goes back to the usual floor", async () => {
    await user("m", "low_lark", { karma: -60 });
    await user("n", "deep_newt", { karma: -40 });
    await user("o", "odd_owl", { karma: -300 });
    await db.batch([
      db.prepare(`UPDATE profiles SET karma_floor = -155 WHERE user_id IN ('m', 'n')`),
      db.prepare(`UPDATE profiles SET karma_floor = -340 WHERE user_id = 'o'`),
      trailFloors(db, "('m', 'n', 'o')"),
    ]);
    expect(await floorOf("m")).toBe(-110);
    expect(await floorOf("n")).toBeNull();
    // Never lowered by a recount.
    expect(await floorOf("o")).toBe(-340);
  });

  it("is raised in the same batch as a vote, for the author's group only", async () => {
    await user("m", "low_lark");
    await user("v", "kind_vole");
    await user("far", "far_finch", { karma: 0 });
    await post("p1", { author: "m" });
    await db.prepare(`UPDATE profiles SET karma_floor = -155 WHERE user_id IN ('m', 'far')`).run();
    await castVote(db, { voterId: "v", type: "post", targetId: "p1", value: 1, now: NOW });
    expect(await floorOf("m")).toBeNull();
    // Someone else's floor waits for their own recount.
    expect(await floorOf("far")).toBe(-155);
  });
});
