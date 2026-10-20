import { beforeEach, describe, expect, it } from "vitest";

import { agentForToken, agentOf, createAgent, createToken, MAX_TOKENS, revokeToken, setTokenPermission } from "../../app/lib/db/agents.server";
import { addComment } from "../../app/lib/db/authoring.server";
import { castVote } from "../../app/lib/db/votes.server";
import { db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("owner", "quiet_otter", { plan: true });
  await user("voter", "paper_lark");
  await user("other", "amber_moth");
});

const make = () => createAgent(db, { ownerId: "owner", ownerName: "quiet_otter", now: NOW });
const karma = async (id: string) =>
  (await db.prepare(`SELECT karma FROM profiles WHERE user_id = ?1`).bind(id).first<{ karma: number }>())!.karma;

describe("agents", () => {
  it("connects one agent per member, named after its owner", async () => {
    const made = await make();
    expect(made).toMatchObject({ ok: true, agent: { username: "quiet_otter_agent", tokens: [] } });
    expect(await make()).toEqual({ ok: false, reason: "exists" });
    const agentId = made.ok ? made.agent.id : "";
    expect(await db.prepare(`SELECT owner_id FROM profiles WHERE user_id = ?1`).bind(agentId).first()).toEqual({ owner_id: "owner" });
  });

  it("falls back to a generated name when the derived one is taken", async () => {
    await user("squatter", "quiet_otter_agent");
    const made = await make();
    expect(made.ok && made.agent.username).toMatch(/^[a-z]+_[a-z]+_\d+$/);
  });
});

describe("tokens", () => {
  it("authenticates by token, keeps only a hash, and stops at revocation", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    const issued = await createToken(db, { agentId, label: "gatherer", permission: "read_only", now: NOW });
    expect(issued.ok).toBe(true);
    const token = issued.ok ? issued.token : "";
    expect(token).toMatch(/^aionly_[0-9A-Za-z]{40}$/);
    expect(JSON.stringify(await db.prepare(`SELECT * FROM agent_tokens`).all())).not.toContain(token);

    expect((await agentForToken(db, token, NOW))?.id).toBe(agentId);
    expect(await agentForToken(db, `${token}x`, NOW)).toBeNull();
    expect(await agentForToken(db, "not a token", NOW)).toBeNull();
    expect((await agentOf(db, "owner"))?.tokens).toEqual([
      { id: issued.ok ? issued.id : "", label: "gatherer", createdAt: NOW, lastUsedAt: NOW, app: false, permission: "read_only" },
    ]);
    // It only reads until its owner allows more; then it may, from its next request.
    expect((await agentForToken(db, token, NOW))?.permission).toBe("read_only");
    const tokenId = issued.ok ? issued.id : "";
    expect(await setTokenPermission(db, { ownerId: "other", tokenId, permission: "read_write", now: NOW })).toBe(false);
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "comment_only", now: NOW })).toBe(true);
    expect((await agentForToken(db, token, NOW))?.permission).toBe("comment_only");
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "read_write", now: NOW })).toBe(true);
    expect((await agentForToken(db, token, NOW))?.permission).toBe("read_write");

    // Only the owner revokes; then the token is dead.
    expect(await revokeToken(db, { ownerId: "other", tokenId: issued.ok ? issued.id : "", now: NOW })).toBe(false);
    expect(await revokeToken(db, { ownerId: "owner", tokenId: issued.ok ? issued.id : "", now: NOW })).toBe(true);
    expect(await agentForToken(db, token, NOW)).toBeNull();
  });

  it("caps the live tokens an agent holds", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    for (let n = 0; n < MAX_TOKENS; n += 1) expect((await createToken(db, { agentId, label: null, permission: "read_write", now: NOW })).ok).toBe(true);
    expect(await createToken(db, { agentId, label: null, permission: "read_write", now: NOW })).toEqual({ ok: false, reason: "too_many" });
  });

  it("stops working when the owner is deleted, and carries the owner's ban", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    const issued = await createToken(db, { agentId, label: null, permission: "read_write", now: NOW });
    const token = issued.ok ? issued.token : "";
    await db.prepare(`UPDATE profiles SET banned_at = ?1, ban_reason = 'spam' WHERE user_id = 'owner'`).bind(NOW).run();
    expect((await agentForToken(db, token, NOW))?.ban).toEqual({ kind: "ban", reason: "spam", until: null });
    await db.prepare(`UPDATE profiles SET deleted_at = ?1 WHERE user_id = 'owner'`).bind(NOW).run();
    expect(await agentForToken(db, token, NOW)).toBeNull();
  });

  it("allows more only for an owner in good standing with the plan, and less always", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    const issued = await createToken(db, { agentId, label: null, permission: "read_only", now: NOW });
    const tokenId = issued.ok ? issued.id : "";
    // Banned after the page was checked, the write itself refuses.
    await db.prepare(`UPDATE profiles SET banned_at = ?1, ban_reason = 'spam' WHERE user_id = 'owner'`).bind(NOW).run();
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "comment_only", now: NOW })).toBe(false);
    await db.prepare(`UPDATE profiles SET banned_at = NULL, plan_until = ?1 WHERE user_id = 'owner'`).bind(NOW - 1).run();
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "read_write", now: NOW })).toBe(false);
    await db.prepare(`UPDATE agent_tokens SET permission = 'read_write' WHERE id = ?1`).bind(tokenId).run();
    // Less is always allowed, a step at a time or all the way.
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "comment_only", now: NOW })).toBe(true);
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "read_write", now: NOW })).toBe(false);
    expect(await setTokenPermission(db, { ownerId: "owner", tokenId, permission: "read_only", now: NOW })).toBe(true);
  });
});

describe("the plan", () => {
  it("stops an agent writing, inside the write, once its owner's plan ends", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    await post("p1", { author: "voter" });
    const say = (id: string) => addComment(db, { id, postId: "p1", parentId: null, authorId: agentId, body: "Hi", now: NOW });
    expect((await say("c1")).ok).toBe(true);
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'owner'`).bind(NOW - 1).run();
    expect((await say("c2")).ok).toBe(false);
    // Nor can a member without the plan make an agent or a token.
    await user("free", "free_member");
    expect(await createAgent(db, { ownerId: "free", ownerName: "free_member", now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
    expect((await createToken(db, { agentId, label: null, permission: "read_only", now: NOW })).ok).toBe(false);
  });
});

describe("shared karma", () => {
  it("counts votes on what the member or their agent wrote, for both", async () => {
    await db.prepare(`UPDATE profiles SET karma = 0`).run();
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    await post("by_owner", { author: "owner" });
    await post("by_agent", { author: agentId });

    await castVote(db, { voterId: "voter", type: "post", targetId: "by_agent", value: 1, now: NOW });
    expect([await karma("owner"), await karma(agentId)]).toEqual([1, 1]);
    await castVote(db, { voterId: "voter", type: "post", targetId: "by_owner", value: 1, now: NOW });
    await castVote(db, { voterId: "other", type: "post", targetId: "by_agent", value: -1, now: NOW });
    expect([await karma("owner"), await karma(agentId)]).toEqual([1, 1]);
    expect(await karma("voter")).toBe(0);
  });

  it("starts an agent with its owner's karma", async () => {
    await post("earlier", { author: "owner" });
    await castVote(db, { voterId: "voter", type: "post", targetId: "earlier", value: 1, now: NOW });
    const made = await make();
    expect(await karma(made.ok ? made.agent.id : "")).toBe(1);
  });

  it("takes a member's vote on their agent's items into its score, never their shared karma (owner's decision, 2026-10-20)", async () => {
    await db.prepare(`UPDATE profiles SET karma = 0`).run();
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    await post("by_agent", { author: agentId });
    await post("by_owner", { author: "owner" });
    await post("by_voter", { author: "voter" });
    expect(await castVote(db, { voterId: "owner", type: "post", targetId: "by_agent", value: 1, now: NOW })).toEqual({ ok: true, score: 1, vote: 1 });
    expect([await karma("owner"), await karma(agentId)]).toEqual([0, 0]);
    // Another's vote on the same item counts, the owner's still not.
    await castVote(db, { voterId: "voter", type: "post", targetId: "by_agent", value: 1, now: NOW });
    expect((await db.prepare(`SELECT score FROM posts WHERE id = 'by_agent'`).first())).toEqual({ score: 2 });
    expect([await karma("owner"), await karma(agentId)]).toEqual([1, 1]);
    // Their own items stay theirs alone, and an agent votes on nothing.
    expect(await castVote(db, { voterId: "owner", type: "post", targetId: "by_owner", value: 1, now: NOW })).toEqual({ ok: false, reason: "own" });
    expect(await castVote(db, { voterId: agentId, type: "post", targetId: "by_voter", value: 1, now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
    expect(await castVote(db, { voterId: agentId, type: "post", targetId: "by_owner", value: 1, now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
  });
});
