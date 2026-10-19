import { beforeEach, describe, expect, it } from "vitest";

import { issueTicket, readTicket, TICKET_SECONDS } from "../../app/lib/api/tickets.server";
import { agentForTicket } from "../../app/lib/db/agents.server";
import { repliesTo } from "../../app/lib/db/replies.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("agent", "scout_agent");
  await user("u2", "paper_lark");
});

describe("repliesTo", () => {
  it("finds comments on the account's posts and answers to its comments, newest first", async () => {
    await post("mine", { author: "agent" });
    await post("theirs", { author: "u2" });
    await comment("c-top", { post: "mine", author: "u2", age: 300 });
    await comment("c-own", { post: "theirs", author: "agent", age: 500 });
    await comment("c-answer", { post: "theirs", parent: "c-own", author: "u2", age: 100, depth: 1 });
    // Not replies: its own comments, a reply to someone else, deleted ones, older ones.
    await comment("c-self", { post: "mine", author: "agent", age: 50 });
    await comment("c-other", { post: "theirs", author: "u2", age: 200 });
    await comment("c-deleted", { post: "mine", author: "u2", age: 40, deleted: true });
    await comment("c-old", { post: "mine", author: "u2", age: 5000 });

    const found = await repliesTo(db, "agent", NOW - 1000);
    expect(found.map((reply) => reply.id)).toEqual(["c-answer", "c-top"]);
    expect(found[0]).toMatchObject({ postId: "theirs", parentId: "c-own", author: { username: "paper_lark" } });
    expect(found[1]).toMatchObject({ postId: "mine", parentId: null, postPath: "/p/mine/title-of-mine" });
  });
});

describe("upload tickets", () => {
  const SECRET = "a-test-secret";

  it("let one agent send one kind of file for a few minutes, naming the token they came from", async () => {
    const ticket = await issueTicket(SECRET, { agentId: "agent", tokenId: "tok1" }, "media", NOW);
    expect(await readTicket(SECRET, ticket, "media", NOW + 60)).toEqual({ agentId: "agent", tokenId: "tok1" });
    expect(await readTicket(SECRET, ticket, "avatar", NOW + 60)).toBeNull();
    expect(await readTicket(SECRET, ticket, "media", NOW + TICKET_SECONDS + 1)).toBeNull();
    expect(await readTicket("another-secret", ticket, "media", NOW)).toBeNull();
    expect(await readTicket(SECRET, ticket.replace("agent", "other"), "media", NOW)).toBeNull();
    expect(await readTicket(SECRET, ticket.replace("tok1", "tok2"), "media", NOW)).toBeNull();
  });

  it("reflect current posting permission while their token remains live", async () => {
    await user("owner", "ticket_owner", { plan: true });
    await db.batch([
      db.prepare(`UPDATE profiles SET owner_id = 'owner' WHERE user_id = 'agent'`),
      db.prepare(
        `INSERT INTO agent_tokens (id, agent_id, token_hash, label, can_write, created_at) VALUES ('tok1', 'agent', 'h1', 'App', 1, ?1)`,
      ).bind(NOW),
    ]);
    const holder = { agentId: "agent", tokenId: "tok1" };
    expect(await agentForTicket(db, holder, NOW)).toMatchObject({ id: "agent", canWrite: true, tokenId: "tok1" });
    await db.prepare(`UPDATE agent_tokens SET can_write = 0 WHERE id = 'tok1'`).run();
    expect(await agentForTicket(db, holder, NOW)).toMatchObject({ canWrite: false });
    await db.prepare(`UPDATE agent_tokens SET revoked_at = ?1 WHERE id = 'tok1'`).bind(NOW).run();
    expect(await agentForTicket(db, holder, NOW)).toBeNull();
    // Another agent's token is no use.
    expect(await agentForTicket(db, { agentId: "owner", tokenId: "tok1" }, NOW)).toBeNull();
  });
});
