import { beforeEach, describe, expect, it } from "vitest";

import { deleteAccount } from "../../app/lib/db/deletion.server";
import { postPage } from "../../app/lib/db/posts.server";
import {
  largerXPhoto,
  linkedX,
  rememberXAccount,
  setXShown,
  signInMethods,
  unlinkMethod,
} from "../../app/lib/db/x-accounts.server";
import { db, NOW, post, reset, user } from "./fixtures";

const X = { id: "1234567890", handle: "otter_makes", photoUrl: "https://pbs.twimg.com/profile_images/1/abc_normal.jpg" };

/** A sign-in method on the account, as Better Auth records it. */
async function method(userId: string, provider: "google" | "twitter") {
  await db.batch([
    db
      .prepare(`INSERT OR IGNORE INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, ?1, ?2, 1, 0, 0)`)
      .bind(userId, `${userId}@x-accounts.invalid`),
    db
      .prepare(`INSERT INTO "account" ("id", "accountId", "providerId", "userId", "createdAt", "updatedAt") VALUES (?1, ?2, ?3, ?4, 0, 0)`)
      .bind(`${userId}-${provider}`, `${provider}-id-of-${userId}`, provider, userId),
  ]);
}

beforeEach(async () => {
  await reset();
  await db.prepare(`DELETE FROM "user" WHERE "email" LIKE '%@x-accounts.invalid'`).run();
  await user("member", "quiet_otter");
  await user("other", "paper_lark");
  await post("p1", { author: "member" });
});

describe("linked X accounts", () => {
  it("show the X mark with the handle when shown, and keep the larger photo", async () => {
    const author = async () => {
      const page = await postPage(db, "p1");
      return page?.state === "live" ? page.post.author.x : null;
    };
    // Made with X: hidden until the member shows it.
    await rememberXAccount(db, "member", X, { shown: false });
    expect(await linkedX(db, "member")).toEqual({ id: X.id, handle: X.handle, photoUrl: "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg", shown: false });
    expect(await author()).toBeUndefined();
    await setXShown(db, "member", true);
    expect(await author()).toBe("otter_makes");
    // Signing in again refreshes the handle and keeps the choice.
    await rememberXAccount(db, "member", { ...X, handle: "otter_builds" });
    expect(await author()).toBe("otter_builds");
    await setXShown(db, "member", false);
    expect(await author()).toBeUndefined();
  });

  it("link one X account to one board account at most", async () => {
    await rememberXAccount(db, "member", X);
    await expect(rememberXAccount(db, "other", X)).rejects.toThrow(/UNIQUE/);
  });

  it("unlink only while another way to sign in remains", async () => {
    await method("member", "twitter");
    await rememberXAccount(db, "member", X, { shown: true });
    // X is the only way in: it stays.
    expect(await unlinkMethod(db, "member", "twitter")).toBe(false);
    expect(await linkedX(db, "member")).not.toBeNull();
    await method("member", "google");
    expect(await signInMethods(db, "member")).toEqual(["google", "twitter"]);
    // With Google too, X can go, and the profile forgets it.
    expect(await unlinkMethod(db, "member", "twitter")).toBe(true);
    expect(await linkedX(db, "member")).toBeNull();
    expect(await unlinkMethod(db, "member", "google")).toBe(false);
    expect(await signInMethods(db, "member")).toEqual(["google"]);
  });

  it("lose the mark when the account is deleted", async () => {
    await rememberXAccount(db, "member", X);
    await deleteAccount(db, { userId: "member", content: false, banned: false, identities: [], now: NOW });
    // Free to link to a new account.
    await rememberXAccount(db, "other", X);
    expect((await linkedX(db, "other"))?.handle).toBe("otter_makes");
  });

  it("asks X for its larger photo", () => {
    expect(largerXPhoto("https://pbs.twimg.com/a/b_normal.png")).toBe("https://pbs.twimg.com/a/b_400x400.png");
    expect(largerXPhoto(null)).toBeNull();
  });
});
