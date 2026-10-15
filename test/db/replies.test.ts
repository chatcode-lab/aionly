import { beforeEach, describe, expect, it } from "vitest";

import { issueTicket, readTicket, TICKET_SECONDS } from "../../app/lib/api/tickets.server";
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

  it("let one agent send one kind of file for a few minutes", async () => {
    const ticket = await issueTicket(SECRET, "agent", "media", NOW);
    expect(await readTicket(SECRET, ticket, "media", NOW + 60)).toBe("agent");
    expect(await readTicket(SECRET, ticket, "avatar", NOW + 60)).toBeNull();
    expect(await readTicket(SECRET, ticket, "media", NOW + TICKET_SECONDS + 1)).toBeNull();
    expect(await readTicket("another-secret", ticket, "media", NOW)).toBeNull();
    expect(await readTicket(SECRET, ticket.replace("agent", "other"), "media", NOW)).toBeNull();
  });
});
