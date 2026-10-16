import { beforeEach, describe, expect, it } from "vitest";

import { pinComment } from "../../app/lib/db/moderation.server";
import { postPage, ROOTS_PER_PAGE } from "../../app/lib/db/posts.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  // The author has the plan, so their agent may take part.
  await user("author", "post_author", { plan: true });
  await user("other", "someone_else");
  await user("admin", "the_admin", { role: "admin" });
  await user("bot", "author_agent");
  await db.prepare(`UPDATE profiles SET owner_id = 'author' WHERE user_id = 'bot'`).run();
  await post("p1", { author: "author" });
  await comment("first", { author: "other", age: 900, score: 1 });
  await comment("second", { author: "other", age: 600, score: 9 });
  await comment("third", { author: "other", age: 300, score: 4 });
  await comment("reply", { author: "other", parent: "first", depth: 1, age: 200 });
});

const ids = async (order?: "old" | "best" | "new") => (await postPage(db, "p1", order))!.comments.map((c) => c.id);
const pin = (actorId: string, commentId: string | null, postId = "p1") => pinComment(db, { postId, commentId, actorId, now: NOW });

describe("pinning a comment", () => {
  it("puts it first in every order, labelled, until it is taken down", async () => {
    expect(await pin("author", "third")).toEqual({ ok: true });
    expect(await ids("old")).toEqual(["third", "first", "second"]);
    expect(await ids("best")).toEqual(["third", "second", "first"]);
    expect(await ids("new")).toEqual(["third", "second", "first"]);
    const page = (await postPage(db, "p1"))!;
    expect(page.comments[0]).toMatchObject({ id: "third", pinned: "author" });
    expect(page.pinned).toEqual({ id: "third", by: "author" });
    // One pin a post: a new one replaces it.
    expect(await pin("author", "second")).toEqual({ ok: true });
    expect((await ids("old"))[0]).toBe("second");
    expect(await pin("author", null)).toEqual({ ok: true });
    expect(await ids("old")).toEqual(["first", "second", "third"]);
  });

  it("is for the post's author, their agent, and admins; only a visible top-level comment", async () => {
    expect(await pin("other", "first")).toEqual({ ok: false, reason: "not_allowed" });
    expect(await pin("bot", "first")).toEqual({ ok: true });
    expect(await pin("author", "reply")).toEqual({ ok: false, reason: "not_found" });
    await db.prepare(`UPDATE comments SET deleted_at = ?1 WHERE id = 'third'`).bind(NOW).run();
    expect(await pin("author", "third")).toEqual({ ok: false, reason: "not_found" });
    // A banned author cannot.
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'author'`).bind(NOW).run();
    expect(await pin("author", "second")).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("lets the member who runs an agent pin on the agent's post", async () => {
    await post("p2", { author: "bot" });
    await comment("on_agent_post", { post: "p2", author: "other" });
    expect(await pin("author", "on_agent_post", "p2")).toEqual({ ok: true });
    expect(await pin("other", null, "p2")).toEqual({ ok: false, reason: "not_allowed" });
  });

  it("keeps a moderator's pin from the author's side, and logs it", async () => {
    expect(await pin("admin", "second")).toEqual({ ok: true });
    expect((await postPage(db, "p1"))!.comments[0]).toMatchObject({ id: "second", pinned: "admin" });
    expect(await pin("author", "first")).toEqual({ ok: false, reason: "moderator" });
    expect(await pin("author", null)).toEqual({ ok: false, reason: "moderator" });
    expect(await db.prepare(`SELECT action, target_id FROM mod_actions`).all().then((r) => r.results)).toEqual([
      { action: "pin_comment", target_id: "second" },
    ]);
    expect(await pin("admin", null)).toEqual({ ok: true });
    expect(await pin("author", "first")).toEqual({ ok: true });
    // The author's own pin is no moderation: nothing more is logged.
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM mod_actions`).first<{ n: number }>())!.n).toBe(2);
  });

  it("stays first on the first page of a long discussion, and a link to it opens that page", async () => {
    const statements = [];
    for (let index = 0; index < ROOTS_PER_PAGE + 10; index += 1) {
      statements.push(
        db.prepare(`INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?1, 'p1', 'other', 'More', ?2)`).bind(`m${String(index).padStart(3, "0")}`, NOW - 100 + index),
      );
    }
    await db.batch(statements);
    // The newest comment, on the last page in oldest-first order.
    expect(await pin("author", "m059")).toEqual({ ok: true });
    const first = (await postPage(db, "p1", "old"))!;
    expect(first.comments[0]!.id).toBe("m059");
    expect(first.comments).toHaveLength(ROOTS_PER_PAGE);
    expect((await postPage(db, "p1", "old", { focus: "m059" }))!.page).toBe(1);
    // Nothing is shown twice, and nothing is lost.
    const second = (await postPage(db, "p1", "old", { page: 2 }))!;
    const all = [...first.comments, ...second.comments].map((c) => c.id);
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(ROOTS_PER_PAGE + 13);
    // The one pushed off the first page by the pin is first on the next.
    expect(second.comments[0]!.id).toBe("m046");
    expect((await postPage(db, "p1", "old", { focus: "m046" }))!.page).toBe(2);
  });
});
