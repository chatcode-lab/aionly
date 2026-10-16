import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord, renameStatus } from "../../app/lib/db/accounts.server";
import { addComment } from "../../app/lib/db/authoring.server";
import { attachInvite, claimInvite, createInvite, inviteStanding } from "../../app/lib/db/invites.server";
import { loadSettings, saveSettings, settingsInForce } from "../../app/lib/db/settings.server";
import { castVote } from "../../app/lib/db/votes.server";
import { DEFAULT_SETTINGS, settingsProblems } from "../../app/lib/settings";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("admin", "the_admin", { role: "admin" });
  await user("member", "plain_member");
});

const save = (values: Parameters<typeof saveSettings>[1]["values"], actorId = "admin") => saveSettings(db, { actorId, values, now: NOW });

describe("settings", () => {
  it("are their defaults until changed, and every value and the set are checked", () => {
    expect(settingsProblems(DEFAULT_SETTINGS)).toEqual({});
    expect(settingsProblems({ ...DEFAULT_SETTINGS, karma_floor: 5, invite_share_percent: 101, comments_per_day: 1.5 })).toEqual({
      karma_floor: "From -100000 to -1.",
      invite_share_percent: "From 0 to 100.",
      comments_per_day: "A whole number.",
    });
  });

  it("are changed by an admin only, all or nothing, and logged", async () => {
    expect(await save({ good_karma: 0, comments_per_day: 50 })).toEqual({ ok: false, problems: { good_karma: "From 1 to 100000." } });
    expect((await settingsInForce(db)).comments_per_day).toBe(100);
    expect(await save({ comments_per_day: 50 }, "member")).toEqual({ ok: false, reason: "not_allowed" });
    expect(await save({ comments_per_day: 50, good_karma: 100 })).toEqual({ ok: true, changed: ["comments_per_day"] });
    expect((await loadSettings(db)).comments_per_day).toBe(50);
    expect(await db.prepare(`SELECT action, target_type, target_id, reason FROM mod_actions`).all().then((r) => r.results)).toEqual([
      { action: "set_setting", target_type: "setting", target_id: "comments_per_day", reason: "100 → 50" },
    ]);
  });

  it("hold inside every write as soon as they change: the daily comment limit", async () => {
    await post("p1", { author: "admin" });
    const comment = (n: number) =>
      addComment(db, { id: `c${n}`, postId: "p1", parentId: null, authorId: "member", body: `Comment ${n}`, now: NOW });
    await save({ comments_per_day: 2 });
    expect((await comment(1)).ok).toBe(true);
    expect((await comment(2)).ok).toBe(true);
    expect(await comment(3)).toMatchObject({ ok: false, reason: "limit" });
    await save({ comments_per_day: 3 });
    expect((await comment(3)).ok).toBe(true);
  });

  it("move the karma floor for everyone at once, a member's read-only standing with it", async () => {
    await db.prepare(`UPDATE profiles SET karma = -60, vote_karma = -60 WHERE user_id = 'member'`).run();
    expect((await accountRecord(db, "member"))!.ban).toBeNull();
    await save({ karma_floor: -50 });
    expect((await accountRecord(db, "member"))!.ban).toMatchObject({ kind: "karma", floor: -50 });
  });

  it("recount everyone's karma when the share of invitees' karma changes", async () => {
    const code = (await createInvite(db, { inviterId: "member", now: NOW }))!;
    expect(await claimInvite(db, { code, userId: "invitee", now: NOW })).toBe(true);
    await user("invitee", "invited_one");
    await attachInvite(db, { userId: "invitee" });
    await post("p1", { author: "invitee" });
    for (const voter of ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8"]) {
      await user(voter, `voter_${voter}`);
      await castVote(db, { voterId: voter, type: "post", targetId: "p1", value: 1, now: NOW });
    }
    const karma = async () => (await db.prepare(`SELECT karma FROM profiles WHERE user_id = 'member'`).first<{ karma: number }>())!.karma;
    // A quarter of 8, by default.
    expect(await karma()).toBe(2);
    await save({ invite_share_percent: 50 });
    expect(await karma()).toBe(4);
    await save({ invite_share_percent: 10 });
    // 10% of 8, rounded down.
    expect(await karma()).toBe(0);
  });

  it("set how many invitations a member has, and how long new ones last", async () => {
    await save({ invites_to_start: 2, invite_days: 3 });
    const standing = await inviteStanding(db, "member", NOW);
    expect(standing.allowance).toBe(2);
    const code = (await createInvite(db, { inviterId: "member", now: NOW }))!;
    expect(await db.prepare(`SELECT expires_at FROM invites WHERE code = ?1`).bind(code).first()).toEqual({ expires_at: NOW + 3 * DAY });
    await createInvite(db, { inviterId: "member", now: NOW });
    expect(await createInvite(db, { inviterId: "member", now: NOW })).toBeNull();
  });

  it("set the wait between name changes", async () => {
    await db.prepare(`INSERT INTO usernames (name, user_id, is_current, created_at) VALUES ('older_name', 'member', 0, ?1)`).bind(NOW - 2 * DAY).run();
    await db.prepare(`UPDATE usernames SET created_at = ?1 WHERE name = 'plain_member'`).bind(NOW - DAY).run();
    expect((await renameStatus(db, "member", NOW)).nextChangeAt).toBe(NOW + 29 * DAY);
    await save({ rename_interval_days: 1 });
    expect((await renameStatus(db, "member", NOW)).nextChangeAt).toBeNull();
  });
});
