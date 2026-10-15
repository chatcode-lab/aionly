import { beforeEach, describe, expect, it } from "vitest";

import {
  attachInvite,
  claimInvite,
  createInvite,
  inviteByCode,
  inviteStanding,
  revokeInvite,
  sweepInviteClaims,
} from "../../app/lib/db/invites.server";
import { deleteAccount } from "../../app/lib/db/deletion.server";
import { profileByName } from "../../app/lib/db/profiles.server";
import { castVote } from "../../app/lib/db/votes.server";
import { OPEN_INVITES } from "../../app/lib/invites";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
  await user("host", "kind_host");
  await user("admin", "the_admin", { role: "admin" });
  await user("bot", "host_agent");
  await db.prepare(`UPDATE profiles SET owner_id = 'host' WHERE user_id = 'bot'`).run();
  for (const voter of ["v1", "v2", "v3", "v4", "v5", "v6", "v7", "v8", "v9"]) await user(voter, `voter_${voter}`);
});

/** Joins `id` through a fresh invitation from `inviter`, as sign-up does. */
async function join(inviter: string, id: string, now = NOW) {
  const code = (await createInvite(db, { inviterId: inviter, now }))!;
  expect(await claimInvite(db, { code, userId: id, now })).toBe(true);
  await user(id, `joined_${id}`);
  await attachInvite(db, { userId: id });
  return code;
}

/** The sign-in record Better Auth writes for an account, which the sweep looks for. */
async function authUser(id: string) {
  await db
    .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, ?1, ?2, 1, 0, 0)`)
    .bind(id, `${id}@invites.invalid`)
    .run();
}

beforeEach(async () => {
  await db.prepare(`DELETE FROM "user" WHERE "email" LIKE '%@invites.invalid'`).run();
});

const karma = async (id: string) =>
  (await db.prepare(`SELECT karma, vote_karma FROM profiles WHERE user_id = ?1`).bind(id).first<{ karma: number; vote_karma: number }>())!;

async function upvotes(author: string, postId: string, count: number) {
  await post(postId, { author });
  for (let index = 1; index <= count; index += 1) {
    await castVote(db, { voterId: `v${index}`, type: "post", targetId: postId, value: 1, now: NOW });
  }
}

describe("invitations", () => {
  it("make one account each, and show who invited whom", async () => {
    const code = await join("host", "newbie");
    expect(code).toMatch(/^[0-9A-HJKMNP-TV-Z]{8}$/);
    expect(await claimInvite(db, { code, userId: "other", now: NOW })).toBe(false);
    expect(await inviteByCode(db, code, NOW)).toMatchObject({ state: "used", inviter: { username: "kind_host" } });
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = 'newbie'`).first()).toEqual({ invited_by: "host" });
    const host = await profileByName(db, "kind_host");
    expect(host?.kind === "profile" && host.profile.invited).toEqual({ names: ["joined_newbie"], total: 1 });
    const newbie = await profileByName(db, "joined_newbie");
    expect(newbie?.kind === "profile" && newbie.profile.invitedBy).toBe("kind_host");
  });

  it("are limited to a few unused at once, except for admins, and never made by agents", async () => {
    for (let index = 0; index < OPEN_INVITES; index += 1) expect(await createInvite(db, { inviterId: "host", now: NOW })).not.toBeNull();
    expect(await createInvite(db, { inviterId: "host", now: NOW })).toBeNull();
    expect((await inviteStanding(db, "host", NOW)).refusal).toBe("limit");
    const [first] = (await inviteStanding(db, "host", NOW)).open;
    expect(await revokeInvite(db, { inviterId: "host", code: first!.code, now: NOW })).toBe(true);
    expect(await inviteByCode(db, first!.code, NOW)).toMatchObject({ state: "revoked" });
    expect(await createInvite(db, { inviterId: "host", now: NOW })).not.toBeNull();

    for (let index = 0; index < OPEN_INVITES + 2; index += 1) expect(await createInvite(db, { inviterId: "admin", now: NOW })).not.toBeNull();
    expect(await createInvite(db, { inviterId: "bot", now: NOW })).toBeNull();
    expect((await inviteStanding(db, "bot", NOW)).refusal).toBe("agent");
  });

  it("expire after two weeks, and a claim that never became an account is freed", async () => {
    const code = (await createInvite(db, { inviterId: "host", now: NOW }))!;
    expect(await inviteByCode(db, code, NOW + 15 * DAY)).toMatchObject({ state: "expired" });
    expect(await claimInvite(db, { code, userId: "late", now: NOW + 15 * DAY })).toBe(false);
    expect(await claimInvite(db, { code, userId: "slow", now: NOW })).toBe(true);
    expect(await sweepInviteClaims(db, NOW + 300)).toBe(0);
    expect(await sweepInviteClaims(db, NOW + 7200)).toBe(1);
    expect(await inviteByCode(db, code, NOW + 7200)).toMatchObject({ state: "open" });
  });

  it("stay with the account a sign-up made, even when its setup failed, and are finished for it", async () => {
    const code = (await createInvite(db, { inviterId: "host", now: NOW }))!;
    expect(await claimInvite(db, { code, userId: "halfway", now: NOW })).toBe(true);
    // The account was made, but neither its profile nor its invitation followed.
    await authUser("halfway");
    expect(await sweepInviteClaims(db, NOW + 7200)).toBe(1);
    // Not freed for someone else: given to the account, profile and all.
    expect(await inviteByCode(db, code, NOW + 7200)).toMatchObject({ state: "used" });
    expect(await claimInvite(db, { code, userId: "second", now: NOW + 7200 })).toBe(false);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = 'halfway'`).first()).toEqual({ invited_by: "host" });
    expect(await db.prepare(`SELECT used_by FROM invites WHERE code = ?1`).bind(code).first()).toEqual({ used_by: "halfway" });
  });

  it("are taken only by the account each was claimed for, when two sign-ups overlap", async () => {
    await user("other_host", "other_host");
    const mine = (await createInvite(db, { inviterId: "host", now: NOW }))!;
    const theirs = (await createInvite(db, { inviterId: "other_host", now: NOW }))!;
    // Two tabs, the same person: both claim, and only the second's account is made.
    expect(await claimInvite(db, { code: mine, userId: "tab_a", now: NOW })).toBe(true);
    expect(await claimInvite(db, { code: theirs, userId: "tab_b", now: NOW })).toBe(true);
    await authUser("tab_b");
    await user("tab_b", "two_tabs");
    await attachInvite(db, { userId: "tab_b" });
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = 'tab_b'`).first()).toEqual({ invited_by: "other_host" });
    expect(await inviteByCode(db, theirs, NOW)).toMatchObject({ state: "used" });
    // The other tab's claim made no account, so its invitation is freed for use.
    expect(await sweepInviteClaims(db, NOW + 7200)).toBe(1);
    expect(await inviteByCode(db, mine, NOW + 7200)).toMatchObject({ state: "open" });
  });

  it("pause below 0 karma, and once half of those invited are below 0 or banned", async () => {
    await db.prepare(`UPDATE profiles SET karma = -1, vote_karma = -1 WHERE user_id = 'host'`).run();
    expect(await createInvite(db, { inviterId: "host", now: NOW })).toBeNull();
    expect((await inviteStanding(db, "host", NOW)).refusal).toBe("karma");
    await db.prepare(`UPDATE profiles SET karma = 0, vote_karma = 0 WHERE user_id = 'host'`).run();

    await join("host", "good");
    await join("host", "bad");
    const pending = (await createInvite(db, { inviterId: "host", now: NOW }))!;
    await db.prepare(`UPDATE profiles SET karma = -3, vote_karma = -3 WHERE user_id = 'bad'`).run();
    // One of two below 0 is half: no new invitations, and open ones stop working.
    expect((await inviteStanding(db, "host", NOW)).refusal).toBe("invitees");
    expect(await inviteByCode(db, pending, NOW)).toMatchObject({ state: "paused" });
    expect(await claimInvite(db, { code: pending, userId: "x", now: NOW })).toBe(false);
    // A third good invitee would tip it back, were inviting open; a recovery does.
    await db.prepare(`UPDATE profiles SET karma = 2, vote_karma = 2 WHERE user_id = 'bad'`).run();
    expect((await inviteStanding(db, "host", NOW)).refusal).toBeNull();
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'bad'`).bind(NOW).run();
    expect((await inviteStanding(db, "host", NOW)).refusal).toBe("invitees");
  });

  it("count an invitee's whole karma, with what their own invitees bring, as the rule says", async () => {
    await join("host", "child");
    await join("child", "grandchild");
    await upvotes("grandchild", "p_grand", 8);
    await post("p_child", { author: "child" });
    await castVote(db, { voterId: "v9", type: "post", targetId: "p_child", value: -1, now: NOW });
    // Below 0 from votes, but +1 in all: not below 0 karma.
    expect(await karma("child")).toEqual({ karma: 1, vote_karma: -1 });
    expect((await inviteStanding(db, "host", NOW)).refusal).toBeNull();
  });
});

describe("karma from invitations", () => {
  it("adds a quarter of each invitee's vote karma, rounded down, to the inviter and their agent", async () => {
    await join("host", "star");
    await upvotes("star", "p_star", 9);
    expect(await karma("star")).toEqual({ karma: 9, vote_karma: 9 });
    expect(await karma("host")).toEqual({ karma: 2, vote_karma: 0 });
    expect(await karma("bot")).toEqual({ karma: 2, vote_karma: 0 });
    // The inviter's own votes add to their share.
    await upvotes("host", "p_host", 3);
    expect(await karma("host")).toEqual({ karma: 5, vote_karma: 3 });
    const profile = await profileByName(db, "kind_host");
    expect(profile?.kind === "profile" && profile.profile.inviteKarma).toBe(2);
  });

  it("shares no losses, passes no further up, and stops when the invitee's account is deleted", async () => {
    await join("host", "middle");
    await join("middle", "far");
    await upvotes("far", "p_far", 8);
    expect(await karma("middle")).toEqual({ karma: 2, vote_karma: 0 });
    // The middle's share is not passed on to the host.
    expect((await karma("host")).karma).toBe(0);
    await post("p_low", { author: "middle" });
    for (const voter of ["v1", "v2", "v3"]) await castVote(db, { voterId: voter, type: "post", targetId: "p_low", value: -1, now: NOW });
    expect((await karma("host")).karma).toBe(0);
    // The invitee's account deleted: the middle keeps only its own karma.
    await deleteAccount(db, { userId: "far", content: false, banned: false, identities: [], now: NOW });
    expect(await karma("middle")).toEqual({ karma: -3, vote_karma: -3 });
  });
});
