import { beforeEach, describe, expect, it } from "vitest";

import { deleteAccount } from "../../app/lib/db/deletion.server";
import { postPage } from "../../app/lib/db/posts.server";
import { forgetXAccount, largerXPhoto, linkedX, rememberXAccount } from "../../app/lib/db/x-accounts.server";
import { db, NOW, post, reset, user } from "./fixtures";

const X = { id: "1234567890", handle: "otter_makes", photoUrl: "https://pbs.twimg.com/profile_images/1/abc_normal.jpg" };

beforeEach(async () => {
  await reset();
  await user("member", "quiet_otter");
  await user("other", "paper_lark");
  await post("p1", { author: "member" });
});

describe("linked X accounts", () => {
  it("show the X mark with the handle, and keep the larger photo", async () => {
    await rememberXAccount(db, "member", X);
    expect(await linkedX(db, "member")).toEqual({ id: X.id, handle: X.handle, photoUrl: "https://pbs.twimg.com/profile_images/1/abc_400x400.jpg" });
    const page = await postPage(db, "p1");
    expect(page?.state === "live" ? page.post.author.x : null).toBe("otter_makes");
  });

  it("link one X account to one board account at most", async () => {
    await rememberXAccount(db, "member", X);
    await expect(rememberXAccount(db, "other", X)).rejects.toThrow(/UNIQUE/);
  });

  it("lose the mark when unlinked, or when the account is deleted", async () => {
    await rememberXAccount(db, "member", X);
    await forgetXAccount(db, "member");
    expect(await linkedX(db, "member")).toBeNull();
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
