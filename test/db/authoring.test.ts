import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { MAX_DEPTH, THREAD_MAX } from "../../app/lib/comments/rules";
import { DEFAULT_SETTINGS } from "../../app/lib/settings";

const COMMENTS_PER_DAY = DEFAULT_SETTINGS.comments_per_day;
import {
  addComment,
  deleteComment,
  deletePost,
  editComment,
  editPost,
} from "../../app/lib/db/authoring.server";
import { findDuplicate } from "../../app/lib/db/submit.server";
import { sweepDeletedPostImages } from "../../app/lib/images.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("u1", "author");
  await user("u2", "reader");
  await user("banned", "banned_one", { banReason: "spam" });
  await user("boss", "the_admin", { role: "admin" });
  await post("p1", { author: "u1" });
});

const row = (id: string) =>
  db
    .prepare(`SELECT body, depth, edited_at, deleted_at, parent_id FROM comments WHERE id = ?1`)
    .bind(id)
    .first<{ body: string; depth: number; edited_at: number | null; deleted_at: number | null; parent_id: string | null }>();

const countOf = async (postId: string) =>
  (await db.prepare(`SELECT comment_count FROM posts WHERE id = ?1`).bind(postId).first<{ comment_count: number }>())!
    .comment_count;

const add = (id: string, fields: { post?: string; parent?: string | null; author?: string; now?: number } = {}) =>
  addComment(db, {
    id,
    postId: fields.post ?? "p1",
    parentId: fields.parent ?? null,
    authorId: fields.author ?? "u2",
    body: `Body of ${id}`,
    now: fields.now ?? NOW,
  });

describe("addComment", () => {
  it("adds a comment and a reply one level deeper, and recounts the post", async () => {
    expect(await add("c1")).toEqual({ ok: true });
    expect(await add("c2", { parent: "c1", author: "u1" })).toEqual({ ok: true });
    expect(await row("c1")).toMatchObject({ depth: 0, parent_id: null });
    expect(await row("c2")).toMatchObject({ depth: 1, parent_id: "c1" });
    expect(await countOf("p1")).toBe(2);
  });

  it("refuses once the discussion holds as many comments as its page shows", async () => {
    await db
      .prepare(
        `INSERT INTO comments (id, post_id, author_id, body, depth, score, created_at)
         WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?1)
         SELECT 'many' || i, 'p1', 'u2', 'Hello.', 0, 0, ?2 FROM n`,
      )
      .bind(THREAD_MAX, NOW)
      .run();
    await db.prepare(`UPDATE posts SET comment_count = ?1 WHERE id = 'p1'`).bind(THREAD_MAX).run();
    expect(await addComment(db, { id: "late", postId: "p1", parentId: null, authorId: "u2", body: "Hi", now: NOW })).toEqual({
      ok: false,
      reason: "full",
    });
  });

  it("refuses under a removed or deleted post", async () => {
    await post("gone", { deleted: true });
    await post("removed", { removed: true });
    expect(await add("c1", { post: "gone" })).toEqual({ ok: false, reason: "closed" });
    expect(await add("c2", { post: "removed" })).toEqual({ ok: false, reason: "closed" });
    expect(await add("c3", { post: "missing" })).toEqual({ ok: false, reason: "closed" });
  });

  it("refuses a reply to a deleted comment, or to one on another post", async () => {
    await post("p2");
    await comment("deleted", { deleted: true });
    await comment("elsewhere", { post: "p2" });
    expect(await add("c1", { parent: "deleted" })).toEqual({ ok: false, reason: "parent" });
    expect(await add("c2", { parent: "elsewhere" })).toEqual({ ok: false, reason: "parent" });
    expect(await add("c3", { parent: "missing" })).toEqual({ ok: false, reason: "parent" });
  });

  it("allows replies to depth 10 and no deeper", async () => {
    await comment("nine", { depth: MAX_DEPTH - 1 });
    await comment("ten", { depth: MAX_DEPTH });
    expect(await add("c1", { parent: "nine" })).toEqual({ ok: true });
    expect((await row("c1"))!.depth).toBe(MAX_DEPTH);
    expect(await add("c2", { parent: "ten" })).toEqual({ ok: false, reason: "depth" });
  });

  it("refuses a banned account inside the write", async () => {
    expect(await add("c1", { author: "banned" })).toEqual({ ok: false, reason: "not_allowed" });
    expect(await countOf("p1")).toBe(0);
  });

  it("stops at the daily ceiling until the oldest counted comment is a day old", async () => {
    const statements = Array.from({ length: COMMENTS_PER_DAY }, (_, index) =>
      db
        .prepare(
          `INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?1, 'p1', 'u2', 'x', ?2)`,
        )
        .bind(`bulk${index}`, NOW - 3600 + index),
    );
    await db.batch(statements);
    expect(await add("over")).toEqual({ ok: false, reason: "limit", retryAt: NOW - 3600 + DAY });
    expect(await add("later", { now: NOW - 3600 + DAY + 1 })).toEqual({ ok: true });

    // Admins are exempt.
    await db.batch(statements.map((_, index) =>
      db.prepare(`INSERT INTO comments (id, post_id, author_id, body, created_at) VALUES (?1, 'p1', 'boss', 'x', ?2)`)
        .bind(`admin${index}`, NOW - 60),
    ));
    expect(await add("admin_more", { author: "boss" })).toEqual({ ok: true });
  });
});

describe("editComment", () => {
  beforeEach(async () => {
    await comment("mine", { author: "u2", body: "first" });
  });

  it("changes the author's own text and marks the time", async () => {
    expect(await editComment(db, { id: "mine", authorId: "u2", body: "second", now: NOW })).toEqual({ ok: true });
    expect(await row("mine")).toMatchObject({ body: "second", edited_at: NOW });
  });

  it("writes nothing for the same text", async () => {
    expect(await editComment(db, { id: "mine", authorId: "u2", body: "first", now: NOW })).toEqual({ ok: true });
    expect((await row("mine"))!.edited_at).toBeNull();
  });

  it("refuses anyone else, a deleted comment, a closed thread, and a ban", async () => {
    expect(await editComment(db, { id: "mine", authorId: "u1", body: "x", now: NOW })).toEqual({ ok: false, reason: "not_found" });
    await comment("deleted", { author: "u2", deleted: true });
    expect(await editComment(db, { id: "deleted", authorId: "u2", body: "x", now: NOW })).toEqual({ ok: false, reason: "closed" });
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b' WHERE id = 'p1'`).run();
    expect(await editComment(db, { id: "mine", authorId: "u2", body: "x", now: NOW })).toEqual({ ok: false, reason: "closed" });
    await db.prepare(`UPDATE posts SET removed_batch_id = NULL WHERE id = 'p1'`).run();
    await comment("theirs", { author: "banned" });
    expect(await editComment(db, { id: "theirs", authorId: "banned", body: "x", now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
  });
});

describe("deleteComment", () => {
  it("deletes the author's own comment for good, wiping its text but keeping its replies", async () => {
    await comment("mine", { author: "u2" });
    await comment("reply", { author: "u1", parent: "mine", depth: 1 });
    expect(await deleteComment(db, { id: "mine", authorId: "u2", now: NOW })).toEqual({ ok: true });
    expect(await row("mine")).toMatchObject({ body: "", deleted_at: NOW });
    expect((await row("reply"))!.deleted_at).toBeNull();
    expect(await deleteComment(db, { id: "mine", authorId: "u2", now: NOW })).toEqual({ ok: false, reason: "closed" });
  });

  it("refuses anyone else and a banned author, and allows it under a removed post", async () => {
    await comment("mine", { author: "u2" });
    await comment("theirs", { author: "banned" });
    expect(await deleteComment(db, { id: "mine", authorId: "u1", now: NOW })).toEqual({ ok: false, reason: "not_found" });
    expect(await deleteComment(db, { id: "theirs", authorId: "banned", now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b' WHERE id = 'p1'`).run();
    expect(await deleteComment(db, { id: "mine", authorId: "u2", now: NOW })).toEqual({ ok: true });
  });
});

describe("editPost", () => {
  const read = () =>
    db.prepare(`SELECT title, origin, description, edited_at FROM posts WHERE id = 'fresh'`).first<{
      title: string;
      origin: string;
      description: string;
      edited_at: number | null;
    }>();

  it("changes the title and origin in the first hour, and the description any time", async () => {
    await post("fresh", { author: "u1", age: 30 * 60 });
    const edit = { id: "fresh", authorId: "u1", title: "New title", origin: "made" as const, description: "A new description here.", now: NOW };
    expect(await editPost(db, edit)).toEqual({ ok: true });
    expect(await read()).toEqual({ title: "New title", origin: "made", description: "A new description here.", edited_at: NOW });
  });

  it("keeps the title after the first hour", async () => {
    await post("fresh", { author: "u1", age: 2 * 3600, title: "Old title" });
    const base = { id: "fresh", authorId: "u1", origin: "found" as const, now: NOW };
    expect(await editPost(db, { ...base, title: "New title", description: "Description of fresh" })).toEqual({
      ok: false,
      reason: "window",
    });
    expect(await editPost(db, { ...base, title: "Old title", description: "A later description." })).toEqual({ ok: true });
    expect(await read()).toMatchObject({ title: "Old title", description: "A later description." });
  });

  it("writes nothing when nothing changed, and refuses others and closed posts", async () => {
    await post("fresh", { author: "u1", title: "Same", description: "Same description here." });
    const same = { id: "fresh", authorId: "u1", title: "Same", origin: "found" as const, description: "Same description here.", now: NOW };
    expect(await editPost(db, same)).toEqual({ ok: true });
    expect((await read())!.edited_at).toBeNull();
    expect(await editPost(db, { ...same, authorId: "u2", description: "Another one entirely." })).toEqual({ ok: false, reason: "not_found" });
    await db.prepare(`UPDATE posts SET deleted_at = ?1 WHERE id = 'fresh'`).bind(NOW).run();
    expect(await editPost(db, { ...same, description: "Another one entirely." })).toEqual({ ok: false, reason: "closed" });
  });
});

describe("deletePost", () => {
  it("deletes the author's own post for good, wiping its text and freeing its link", async () => {
    await post("mine", { author: "u1", key: "url:example.com/shared" });
    expect(await findDuplicate(db, "url:example.com/shared", { origin: "found", now: NOW })).toEqual({ id: "mine", state: "live" });
    expect(await deletePost(db, { id: "mine", authorId: "u1", now: NOW })).toEqual({ ok: true });
    expect(
      await db.prepare(`SELECT title, description, deleted_at FROM posts WHERE id = 'mine'`).first(),
    ).toEqual({ title: "", description: "", deleted_at: NOW });
    expect(await findDuplicate(db, "url:example.com/shared", { origin: "found", now: NOW })).toBeNull();
    await post("again", { author: "u2", key: "url:example.com/shared" });
    expect(await deletePost(db, { id: "mine", authorId: "u1", now: NOW })).toEqual({ ok: false, reason: "closed" });
  });

  it("refuses anyone else, a removed post, and a banned author", async () => {
    await post("removed", { author: "u1", removed: true });
    await post("theirs", { author: "banned" });
    expect(await deletePost(db, { id: "p1", authorId: "u2", now: NOW })).toEqual({ ok: false, reason: "not_found" });
    expect(await deletePost(db, { id: "removed", authorId: "u1", now: NOW })).toEqual({ ok: false, reason: "closed" });
    expect(await deletePost(db, { id: "theirs", authorId: "banned", now: NOW })).toEqual({ ok: false, reason: "not_allowed" });
  });
});

describe("sweepDeletedPostImages", () => {
  it("deletes the pictures of author-deleted posts and keeps a removed post's", async () => {
    const bucket = env.IMAGES;
    for (const key of ["deleted_pic", "removed_pic", "live_pic"]) {
      await bucket.put(key, new Uint8Array([0xff, 0xd8, 0xff]));
      await db
        .prepare(
          `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at)
           VALUES (?1, 'u1', 'post', 'attached', 'image/jpeg', 3, ?2)`,
        )
        .bind(key, NOW)
        .run();
    }
    await post("deleted", { deleted: true });
    await post("removed", { removed: true });
    await db.batch([
      db.prepare(`UPDATE posts SET thumb_key = 'deleted_pic' WHERE id = 'deleted'`),
      db.prepare(`UPDATE posts SET thumb_key = 'removed_pic' WHERE id = 'removed'`),
      db.prepare(`UPDATE posts SET thumb_key = 'live_pic' WHERE id = 'p1'`),
    ]);

    expect(await sweepDeletedPostImages(db, bucket)).toBe(1);
    expect(await bucket.head("deleted_pic")).toBeNull();
    expect(await bucket.head("removed_pic")).not.toBeNull();
    expect(await bucket.head("live_pic")).not.toBeNull();
    const { results } = await db.prepare(`SELECT key FROM images ORDER BY key`).all<{ key: string }>();
    expect(results.map((image) => image.key)).toEqual(["live_pic", "removed_pic"]);
    expect(await db.prepare(`SELECT thumb_key FROM posts WHERE id = 'deleted'`).first()).toEqual({ thumb_key: null });
  });
});
