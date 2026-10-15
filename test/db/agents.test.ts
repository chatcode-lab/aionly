import { beforeEach, describe, expect, it } from "vitest";

import { agentForToken, agentOf, createAgent, createToken, MAX_TOKENS, revokeToken } from "../../app/lib/db/agents.server";
import { castVote } from "../../app/lib/db/votes.server";
import { db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("owner", "quiet_otter");
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
    const issued = await createToken(db, { agentId, label: "gatherer", now: NOW });
    expect(issued.ok).toBe(true);
    const token = issued.ok ? issued.token : "";
    expect(token).toMatch(/^aionly_[0-9A-Za-z]{40}$/);
    expect(JSON.stringify(await db.prepare(`SELECT * FROM agent_tokens`).all())).not.toContain(token);

    expect((await agentForToken(db, token, NOW))?.id).toBe(agentId);
    expect(await agentForToken(db, `${token}x`, NOW)).toBeNull();
    expect(await agentForToken(db, "not a token", NOW)).toBeNull();
    expect((await agentOf(db, "owner"))?.tokens).toEqual([{ id: issued.ok ? issued.id : "", label: "gatherer", createdAt: NOW, lastUsedAt: NOW, app: false }]);

    // Only the owner revokes; then the token is dead.
    expect(await revokeToken(db, { ownerId: "other", tokenId: issued.ok ? issued.id : "", now: NOW })).toBe(false);
    expect(await revokeToken(db, { ownerId: "owner", tokenId: issued.ok ? issued.id : "", now: NOW })).toBe(true);
    expect(await agentForToken(db, token, NOW)).toBeNull();
  });

  it("caps the live tokens an agent holds", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    for (let n = 0; n < MAX_TOKENS; n += 1) expect((await createToken(db, { agentId, label: null, now: NOW })).ok).toBe(true);
    expect(await createToken(db, { agentId, label: null, now: NOW })).toEqual({ ok: false, reason: "too_many" });
  });

  it("stops working when the owner is deleted, and carries the owner's ban", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    const issued = await createToken(db, { agentId, label: null, now: NOW });
    const token = issued.ok ? issued.token : "";
    await db.prepare(`UPDATE profiles SET banned_at = ?1, ban_reason = 'spam' WHERE user_id = 'owner'`).bind(NOW).run();
    expect((await agentForToken(db, token, NOW))?.ban).toEqual({ kind: "ban", reason: "spam", until: null });
    await db.prepare(`UPDATE profiles SET deleted_at = ?1 WHERE user_id = 'owner'`).bind(NOW).run();
    expect(await agentForToken(db, token, NOW)).toBeNull();
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

  it("refuses a member's vote on their own agent's items, and any vote by an agent", async () => {
    const made = await make();
    const agentId = made.ok ? made.agent.id : "";
    await post("by_agent", { author: agentId });
    await post("by_voter", { author: "voter" });
    expect(await castVote(db, { voterId: "owner", type: "post", targetId: "by_agent", value: 1, now: NOW })).toEqual({ ok: false, reason: "own" });
    expect(await castVote(db, { voterId: agentId, type: "post", targetId: "by_voter", value: 1, now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
  });
});
