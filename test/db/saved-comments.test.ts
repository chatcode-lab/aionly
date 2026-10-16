import { beforeEach, describe, expect, it } from "vitest";

import { savedComments, savedCommentsAmong, setSavedComment } from "../../app/lib/db/bookmarks.server";
import { deleteAccount } from "../../app/lib/db/deletion.server";
import { viewerMarks } from "../../app/lib/db/marks.server";
import { comment, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("reader", "keen_reader");
  await user("writer", "good_writer");
  await post("p1", { author: "writer", title: "A post worth reading" });
  await comment("c1", { author: "writer", body: "The useful one.", age: 900 });
  await comment("c2", { author: "writer", body: "Another.", age: 600 });
});

const save = (commentId: string, saved = true, now = NOW) => setSavedComment(db, { userId: "reader", commentId, saved, now });

describe("saved comments", () => {
  it("are saved and listed newest saved first, with their post, and marked on the page", async () => {
    expect(await save("c1", true, NOW)).toBe(true);
    expect(await save("c2", true, NOW + 5)).toBe(true);
    // Saving again is no change.
    expect(await save("c1", true, NOW + 9)).toBe(true);
    const list = await savedComments(db, "reader");
    expect(list.map((entry) => (entry.state === "live" ? entry.comment.id : entry.commentId))).toEqual(["c2", "c1"]);
    expect(list[1]).toMatchObject({
      state: "live",
      comment: { body: "The useful one.", postTitle: "A post worth reading", postPath: "/p/p1/a-post-worth-reading", author: { username: "good_writer" } },
    });
    expect(await savedCommentsAmong(db, "reader", ["c1", "c2", "nope"])).toEqual(expect.arrayContaining(["c1", "c2"]));
    expect((await viewerMarks(db, "reader", { comments: ["c1"] })).savedComments).toEqual(["c1"]);
    expect(await save("c1", false)).toBe(true);
    expect((await savedComments(db, "reader")).map((entry) => (entry.state === "live" ? entry.comment.id : ""))).toEqual(["c2"]);
  });

  it("show a comment gone since as gone, without its text, and refuse saving one already gone", async () => {
    await save("c1");
    await db.prepare(`UPDATE comments SET removed_batch_id = 'b1' WHERE id = 'c1'`).run();
    const [entry] = await savedComments(db, "reader");
    expect(entry).toEqual({ state: "removed", savedAt: NOW, commentId: "c1" });
    expect(JSON.stringify(entry)).not.toContain("useful");
    expect(await save("c1")).toBe(true); // still saved: unsaving stays possible
    await db.prepare(`UPDATE posts SET deleted_at = ?1 WHERE id = 'p1'`).bind(NOW).run();
    expect(await save("c2")).toBe(false);
  });

  it("go with the account that saved them", async () => {
    await save("c1");
    await deleteAccount(db, { userId: "reader", content: false, banned: false, identities: [], now: NOW });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM comment_bookmarks`).first()).toEqual({ n: 0 });
  });
});
