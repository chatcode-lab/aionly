import { beforeEach, describe, expect, it } from "vitest";

import { googlePhotoIsDefault } from "../../app/lib/auth.server";
import { chooseCause, fundSummary, nominations, openVote, postIdOf, startVote } from "../../app/lib/db/fund.server";
import { createPartnerLink, joinedThrough, claimPartnerJoin } from "../../app/lib/db/partners.server";
import { freshStartAmount } from "../../app/lib/plan";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

describe("members choosing where the fund gives", () => {
  beforeEach(async () => {
    await reset();
    await user("boss", "head_admin", { role: "admin" });
    await user("u1", "member_one");
    await post("vote01a", { author: "boss", title: "Where should the aion.ly fund give $240?" });
  });

  it("opens a vote in a live post, lists its top-level comments by votes, and closes when the cause is named", async () => {
    expect(postIdOf("https://aion.ly/p/vote01a/where-should")).toBe("vote01a");
    expect(postIdOf("vote01a")).toBe("vote01a");
    expect(postIdOf("https://aion.ly/u/someone")).toBeNull();
    expect(await startVote(db, { postId: "nopost1", closesAt: NOW + DAY, actorId: "boss", now: NOW })).toEqual({ ok: false, reason: "no_post" });
    expect(await startVote(db, { postId: "vote01a", closesAt: NOW + 7 * DAY, actorId: "boss", now: NOW })).toEqual({ ok: true });
    expect(await startVote(db, { postId: "vote01a", closesAt: NOW + 7 * DAY, actorId: "boss", now: NOW })).toEqual({ ok: false, reason: "open_already" });

    await comment("n1", { post: "vote01a", author: "u1", body: "Open Climate Fix: https://openclimatefix.org", score: 3 });
    await comment("n2", { post: "vote01a", author: "boss", body: "A school's AI club", score: 7 });
    await comment("r1", { post: "vote01a", author: "u1", parent: "n2", body: "A reply, not a nomination", score: 9 });
    expect((await nominations(db, "vote01a")).map((entry) => [entry.id, entry.score])).toEqual([
      ["n2", 7],
      ["n1", 3],
    ]);
    const open = await fundSummary(db);
    expect(open.vote).toMatchObject({ postId: "vote01a", closesAt: NOW + 7 * DAY });
    expect(open.cause).toBeNull();

    await chooseCause(db, { name: "A school's AI club", url: "https://club.example.org/", why: null, actorId: "boss", now: NOW + 8 * DAY });
    expect(await openVote(db)).toBeNull();
    const decided = await fundSummary(db);
    expect(decided.vote).toBeNull();
    expect(decided.cause).toMatchObject({ name: "A school's AI club", vote: { path: expect.stringMatching(/^\/p\/vote01a\//) } });
  });
});

describe("a fresh start's amount", () => {
  it("is whole dollars from its price to the most one payment takes", () => {
    expect(freshStartAmount("20")).toBe(2000);
    expect(freshStartAmount("$75")).toBe(7500);
    expect(freshStartAmount("19")).toBeNull();
    expect(freshStartAmount("20.5")).toBeNull();
    expect(freshStartAmount("1001")).toBeNull();
    expect(freshStartAmount("")).toBeNull();
  });
});

describe("Google's default photo", () => {
  const answer = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;
  it("is told by the People API's flag on the primary photo; unknown counts as a photo", async () => {
    expect(await googlePhotoIsDefault("t", answer({ photos: [{ default: true, metadata: { primary: true } }] }))).toBe(true);
    expect(await googlePhotoIsDefault("t", answer({ photos: [{ metadata: { primary: true } }] }))).toBe(false);
    expect(await googlePhotoIsDefault("t", answer({ error: { status: "PERMISSION_DENIED" } }, 403))).toBe(false);
  });
});

describe("who joined through a partner link", () => {
  beforeEach(async () => {
    await reset();
    await user("boss", "head_admin", { role: "admin" });
  });

  it("lists them by name for admins, even on a link with no share", async () => {
    expect(
      await createPartnerLink(db, { code: "mine", partner: "head_admin", sharePercent: 0, shareMonths: 12, maxUses: null, endsAt: null, note: null, actorId: "boss", now: NOW }),
    ).toBeNull();
    for (const [id, name] of [["a1", "first_joiner"], ["a2", "second_joiner"]] as const) {
      await claimPartnerJoin(db, { code: "mine", userId: id, now: NOW });
      await user(id, name);
    }
    expect((await joinedThrough(db, ["mine"])).mine?.map((member) => member.username).sort()).toEqual(["first_joiner", "second_joiner"]);
  });
});
