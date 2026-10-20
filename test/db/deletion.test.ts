import { beforeEach, describe, expect, it } from "vitest";

import { createAgent, createToken, agentForToken } from "../../app/lib/db/agents.server";
import {
  deleteAccount,
  identityHash,
  IDENTITY_MEMORY_DAYS,
  signUpRefusal,
  sweepDeletedIdentities,
} from "../../app/lib/db/deletion.server";
import { deleteComment, deletePost } from "../../app/lib/db/authoring.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

const SECRET = "test-secret";

beforeEach(async () => {
  await reset();
  await db.prepare(`DELETE FROM deleted_identities`).run();
  await db.prepare(`DELETE FROM "user"`).run();
  await user("leaver", "quiet_otter", { plan: true });
  await user("other", "paper_lark");
  const iso = new Date(NOW * 1000).toISOString();
  await db.batch([
    db
      .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('leaver', 'Private Name', 'leaver@example.invalid', 1, ?1, ?1)`)
      .bind(iso),
    db
      .prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('a1', 'google-sub-1', 'google', 'leaver', ?1, ?1)`)
      .bind(iso),
    db
      .prepare(`INSERT INTO "session" ("id", "token", "userId", "expiresAt", "createdAt", "updatedAt") VALUES ('s1', 't1', 'leaver', ?1, ?1, ?1)`)
      .bind(iso),
  ]);
  await post("p1", { author: "leaver" });
  await post("p2", { author: "other" });
  await comment("c1", { post: "p2", author: "leaver" });
  await db.prepare(`INSERT INTO bookmarks (user_id, post_id, created_at) VALUES ('leaver', 'p2', ?1)`).bind(NOW).run();
});

const leave = async (content: boolean, banned = false) =>
  deleteAccount(db, {
    userId: "leaver",
    content,
    banned,
    identities: [await identityHash(SECRET, "google", "google-sub-1")],
    now: NOW,
  });

describe("account deletion", () => {
  it("takes with it the private copies of what the account deleted, and no one else's (owner's decision, 2026-10-20)", async () => {
    await comment("c2", { post: "p1", author: "other" });
    expect(await deletePost(db, { id: "p1", authorId: "leaver", now: NOW })).toEqual({ ok: true });
    expect(await deleteComment(db, { id: "c2", authorId: "other", now: NOW })).toEqual({ ok: true });
    const copies = () => db.prepare(`SELECT item_id FROM deleted_texts ORDER BY item_id`).all<{ item_id: string }>();
    expect((await copies()).results.map((row) => row.item_id)).toEqual(["c2", "p1"]);
    await leave(false);
    expect((await copies()).results.map((row) => row.item_id)).toEqual(["c2"]);
  });

  it("queues, in its own write, the files of every post it deletes, one published just before included (review F99)", async () => {
    await db.batch([
      db.prepare(`INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at) VALUES ('snap_file', 'leaver', 'post', 'attached', 'image/png', 10, ?1)`).bind(NOW),
      db.prepare(`UPDATE posts SET thumb_key = 'snap_file' WHERE id = 'p1'`),
    ]);
    expect(await leave(true)).toEqual(["snap_file"]);
    expect(await db.prepare(`SELECT key FROM images WHERE key = 'snap_file'`).first()).toBeNull();
    expect(await db.prepare(`SELECT key FROM file_deletions`).all()).toMatchObject({ results: [{ key: "snap_file" }] });
    expect(await db.prepare(`SELECT thumb_key, deleted_at FROM posts WHERE id = 'p1'`).first()).toEqual({ thumb_key: null, deleted_at: NOW });
  });

  it("removes sign-in records and sessions, and keeps a tombstone that names no one", async () => {
    await leave(false);
    for (const table of ["user", "account", "session"]) {
      expect((await db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).first<{ n: number }>())!.n, table).toBe(0);
    }
    const profile = await db.prepare(`SELECT deleted_at, avatar_key FROM profiles WHERE user_id = 'leaver'`).first();
    expect(profile).toEqual({ deleted_at: NOW, avatar_key: null });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM bookmarks WHERE user_id = 'leaver'`).first()).toEqual({ n: 0 });
    // Content stays unless asked otherwise.
    expect(await db.prepare(`SELECT deleted_at, title FROM posts WHERE id = 'p1'`).first()).toEqual({ deleted_at: null, title: "Title of p1" });
  });

  it("deletes posts and comments too when asked, wiping their text", async () => {
    await leave(true);
    expect(await db.prepare(`SELECT deleted_at, title, description FROM posts WHERE id = 'p1'`).first()).toEqual({
      deleted_at: NOW,
      title: "",
      description: "",
    });
    expect(await db.prepare(`SELECT deleted_at, body FROM comments WHERE id = 'c1'`).first()).toEqual({ deleted_at: NOW, body: "" });
    expect(await db.prepare(`SELECT deleted_at FROM posts WHERE id = 'p2'`).first()).toEqual({ deleted_at: null });
  });

  it("takes the agent along, and its tokens stop working", async () => {
    const made = await createAgent(db, { ownerId: "leaver", ownerName: "quiet_otter", now: NOW });
    const agentId = made.ok ? made.agent.id : "";
    const issued = await createToken(db, { agentId, label: null, permission: "read_write", now: NOW });
    await post("by_agent", { author: agentId });
    await leave(true);
    expect(await agentForToken(db, issued.ok ? issued.token : "", NOW)).toBeNull();
    expect(await db.prepare(`SELECT deleted_at FROM profiles WHERE user_id = ?1`).bind(agentId).first()).toEqual({ deleted_at: NOW });
    expect(await db.prepare(`SELECT deleted_at FROM posts WHERE id = 'by_agent'`).first()).toEqual({ deleted_at: NOW });
  });
});

describe("the sign-up block", () => {
  const refusal = (now: number) => signUpRefusal(db, { secret: SECRET, provider: "google", accountId: "google-sub-1", now });

  it("refuses the same Google account for 30 days, and only it", async () => {
    await leave(false);
    expect(await refusal(NOW + DAY)).toBe("deleted");
    expect(await signUpRefusal(db, { secret: SECRET, provider: "google", accountId: "someone-else", now: NOW })).toBeNull();
    expect(await refusal(NOW + IDENTITY_MEMORY_DAYS * DAY + 1)).toBeNull();
    // The table holds a keyed hash, never the ID itself.
    expect(JSON.stringify(await db.prepare(`SELECT * FROM deleted_identities`).all())).not.toContain("google-sub-1");
  });

  it("refuses a banned account's identity for good, and the sweep keeps it", async () => {
    await leave(false, true);
    expect(await sweepDeletedIdentities(db, NOW + 400 * DAY)).toBe(0);
    expect(await refusal(NOW + 400 * DAY)).toBe("banned");
  });

  it("sweeps unbanned identities once their time is up", async () => {
    await leave(false);
    expect(await sweepDeletedIdentities(db, NOW + DAY)).toBe(0);
    expect(await sweepDeletedIdentities(db, NOW + (IDENTITY_MEMORY_DAYS + 1) * DAY)).toBe(1);
  });
});
