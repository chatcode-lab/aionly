import { beforeEach, describe, expect, it } from "vitest";

import { deleteAccount } from "../../app/lib/db/deletion.server";
import { postPage } from "../../app/lib/db/posts.server";
import {
  largerXPhoto,
  linkedX,
  rememberXAccount,
  clearStaleX,
  setXShown,
  unlinkMethod,
} from "../../app/lib/db/x-accounts.server";
import { db, NOW, post, reset, user } from "./fixtures";

const X = { id: "1234567890", handle: "otter_makes", photoUrl: "https://pbs.twimg.com/profile_images/1/abc_normal.jpg" };

/** The sign-in records the member has, by provider. */
const providers = async () =>
  (await db.prepare(`SELECT "providerId" AS provider FROM "account" WHERE "userId" = 'member' ORDER BY 1`).all<{ provider: string }>()).results.map(
    (row) => row.provider,
  );

/** A sign-in method on the account, as Better Auth records it. */
async function method(userId: string, provider: "google" | "twitter", accountId = `${provider}-id-of-${userId}`) {
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, ?1, ?2, 1, 0, 0)`)
      .bind(userId, `${userId}@x-accounts.invalid`),
    db
      .prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, 0, 0)`)
      .bind(`${userId}-${provider}`, accountId, provider, userId),
  ]);
}

beforeEach(async () => {
  await reset();
  await db.prepare(`DELETE FROM "user" WHERE "email" LIKE '%@x-accounts.invalid'`).run();
  await user("member", "quiet_otter", { plan: true });
  await user("other", "paper_lark");
  await post("p1", { author: "member" });
});

describe("linked X accounts", () => {
  it("show the X mark with the handle when shown, and keep the larger photo", async () => {
    const author = async () => {
      const page = await postPage(db, "p1");
      return page?.state === "live" ? page.post.author.x : null;
    };
    // Hidden until the member shows it.
    await method("member", "twitter", X.id);
    await rememberXAccount(db, "member", X, { shown: false });
    expect(await linkedX(db, "member")).toEqual({ id: X.id, handle: X.handle, photoUrl: "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg", shown: false });
    expect(await author()).toBeUndefined();
    await setXShown(db, "member", true);
    expect(await author()).toBe("otter_makes");
    // Linking again refreshes the handle and keeps the choice.
    await rememberXAccount(db, "member", { ...X, handle: "otter_builds" });
    expect(await author()).toBe("otter_builds");
    // Shown only while the plan lasts, as the Supporter mark is.
    await db.prepare(`UPDATE profiles SET plan_until = 1 WHERE user_id = 'member'`).run();
    expect(await author()).toBeUndefined();
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'member'`).bind(NOW + 86400).run();
    await setXShown(db, "member", false);
    expect(await author()).toBeUndefined();
  });

  it("link one X account to one board account at most", async () => {
    await method("member", "twitter", X.id);
    await expect(method("other", "twitter", X.id)).rejects.toThrow(/UNIQUE/);
  });

  it("are never written back by a late link step once unlinked, nor shown without their sign-in record", async () => {
    await method("member", "google");
    await method("member", "twitter", X.id);
    // Another tab unlinks before the link's own last step runs.
    expect(await unlinkMethod(db, "member", "twitter")).toBe(true);
    await rememberXAccount(db, "member", X, { shown: true });
    expect(await db.prepare(`SELECT x_id, x_shown FROM profiles WHERE user_id = 'member'`).first()).toEqual({ x_id: null, x_shown: 0 });
    // Details left behind from before are not shown, and Settings clears them.
    await db.prepare(`UPDATE profiles SET x_id = ?1, x_handle = 'otter_makes', x_shown = 1 WHERE user_id = 'member'`).bind(X.id).run();
    const page = await postPage(db, "p1");
    expect(page?.state === "live" ? page.post.author.x : "missing").toBeUndefined();
    await clearStaleX(db, "member");
    expect(await db.prepare(`SELECT x_id FROM profiles WHERE user_id = 'member'`).first()).toEqual({ x_id: null });
  });

  it("are not written for a member made read-only while X was asking", async () => {
    await method("member", "twitter", X.id);
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'member'`).bind(NOW).run();
    await rememberXAccount(db, "member", X, { shown: true, now: NOW });
    expect(await db.prepare(`SELECT x_id FROM profiles WHERE user_id = 'member'`).first()).toEqual({ x_id: null });
  });

  it("unlink only while another way to sign in remains", async () => {
    await method("member", "twitter");
    await rememberXAccount(db, "member", X, { shown: true });
    // X is the only way in: it stays.
    expect(await unlinkMethod(db, "member", "twitter")).toBe(false);
    expect(await linkedX(db, "member")).not.toBeNull();
    await method("member", "google");
    expect(await providers()).toEqual(["google", "twitter"]);
    // With Google too, X can go, and the profile forgets it.
    expect(await unlinkMethod(db, "member", "twitter")).toBe(true);
    expect(await linkedX(db, "member")).toBeNull();
    expect(await unlinkMethod(db, "member", "google")).toBe(false);
    expect(await providers()).toEqual(["google"]);
  });

  it("count as linked by their sign-in record, even when X's details did not arrive", async () => {
    await method("member", "twitter");
    // The link landed; writing the handle and photo did not.
    expect(await linkedX(db, "member")).toEqual({ id: "twitter-id-of-member", handle: null, photoUrl: null, shown: false });
    const page = await postPage(db, "p1");
    expect(page?.state === "live" ? page.post.author.x : "missing").toBeUndefined();
    await method("member", "google");
    expect(await unlinkMethod(db, "member", "twitter")).toBe(true);
    expect(await linkedX(db, "member")).toBeNull();
  });

  it("are one of each kind per account, held by the database", async () => {
    await method("member", "twitter");
    await expect(
      db
        .prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES ('second', 'another-x', 'twitter', 'member', 0, 0)`)
        .run(),
    ).rejects.toThrow(/UNIQUE/);
  });

  it("lose the mark when the account is deleted", async () => {
    await rememberXAccount(db, "member", X);
    await deleteAccount(db, { userId: "member", content: false, banned: false, identities: [], now: NOW });
    // Free to link to a new account.
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'other'`).bind(NOW + 86400).run();
    await method("other", "twitter", X.id);
    await rememberXAccount(db, "other", X);
    expect((await linkedX(db, "other"))?.handle).toBe("otter_makes");
  });

  it("asks X for its larger photo", () => {
    expect(largerXPhoto("https://pbs.twimg.com/a/b_normal.png")).toBe("https://pbs.twimg.com/a/b_400x400.png");
    expect(largerXPhoto(null)).toBeNull();
  });
});
