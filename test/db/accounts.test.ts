import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { usernameProblem } from "../../app/lib/accounts/usernames";
import {
  accountRecord,
  createProfile,
  sweepExpiredVerifications,
  participantCondition,
  renameStatus,
  renameUser,
  grantNameAllowance,
} from "../../app/lib/db/accounts.server";
import { takeName } from "../../app/lib/db/moderation.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

beforeEach(async () => {
  await reset();
});

async function currentName(userId: string): Promise<string | undefined> {
  const row = await db
    .prepare(`SELECT name FROM usernames WHERE user_id = ?1 AND is_current = 1`)
    .bind(userId)
    .first<{ name: string }>();
  return row?.name;
}

describe("createProfile", () => {
  it("gives a new account a profile and an allowed generated name", async () => {
    await createProfile(db, "new1", NOW);
    const name = await currentName("new1");
    expect(name && usernameProblem(name)).toBeNull();
    const record = await accountRecord(db, "new1", NOW);
    expect(record).toMatchObject({ id: "new1", karma: 0, role: "user", ban: null, deleted: false });
  });

  it("starts the daily digest, each kind it brings counted as sent, so the first comes with the next period", async () => {
    await createProfile(db, "new1", NOW);
    const row = await db.prepare(`SELECT digest, daily_digest_at, weekly_digest_at, monthly_digest_at FROM profiles WHERE user_id = 'new1'`).first();
    expect(row).toEqual({ digest: "daily", daily_digest_at: NOW, weekly_digest_at: NOW, monthly_digest_at: NOW });
  });

  it("is safe to repeat, keeping the first name", async () => {
    await createProfile(db, "new1", NOW);
    const first = await currentName("new1");
    await createProfile(db, "new1", NOW + 10);
    expect(await currentName("new1")).toBe(first);
    const count = await db
      .prepare(`SELECT COUNT(*) AS n FROM usernames WHERE user_id = 'new1'`)
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });
});

describe("renameUser", () => {
  beforeEach(async () => {
    await user("u1", "quiet_otter_482");
    await user("u2", "paper_lark_17");
  });

  it("allows the first change at once, and keeps the old name reserved", async () => {
    expect(await renameStatus(db, "u1", NOW)).toEqual({ firstChange: true, nextChangeAt: null, planChange: false, planChangeLeft: true });
    expect(await renameUser(db, "u1", "otter_prime", NOW)).toEqual({ ok: true });
    expect(await currentName("u1")).toBe("otter_prime");
    expect(await renameUser(db, "u2", "quiet_otter_482", NOW)).toEqual({ ok: false, reason: "taken" });
  });

  it("allows a later change only after 30 days", async () => {
    await renameUser(db, "u1", "otter_prime", NOW);
    expect(await renameStatus(db, "u1", NOW + DAY)).toEqual({
      firstChange: false,
      nextChangeAt: NOW + 30 * DAY,
      planChange: false,
      planChangeLeft: true,
    });
    expect(await renameUser(db, "u1", "otter_again", NOW + DAY)).toEqual({ ok: false, reason: "too_soon" });
    expect(await currentName("u1")).toBe("otter_prime");
    expect(await renameUser(db, "u1", "otter_again", NOW + 30 * DAY)).toEqual({ ok: true });
  });

  it("refuses a name in use or used before, and treats the same name as no change", async () => {
    expect(await renameUser(db, "u1", "paper_lark_17", NOW)).toEqual({ ok: false, reason: "taken" });
    expect(await renameUser(db, "u1", "quiet_otter_482", NOW)).toEqual({ ok: false, reason: "same" });
    await renameUser(db, "u1", "otter_prime", NOW);
    // Even its own earlier name stays retired.
    expect(await renameUser(db, "u1", "quiet_otter_482", NOW + 40 * DAY)).toEqual({ ok: false, reason: "taken" });
  });

  it("never leaves an account with two current names or none", async () => {
    await renameUser(db, "u1", "otter_prime", NOW);
    await renameUser(db, "u1", "otter_again", NOW + DAY);
    const rows = await db
      .prepare(`SELECT COUNT(*) AS n FROM usernames WHERE user_id = 'u1' AND is_current = 1`)
      .first<{ n: number }>();
    expect(rows?.n).toBe(1);
  });

  it("refuses a banned account inside the write itself", async () => {
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'u1'`).bind(NOW).run();
    expect(await renameUser(db, "u1", "otter_prime", NOW)).toEqual({ ok: false, reason: "too_soon" });
    expect(await currentName("u1")).toBe("quiet_otter_482");
  });
  it("gives a member with the plan one change before the wait is over, once ever", async () => {
    const used = async () => db.prepare(`SELECT plan_rename_at, plan_rename FROM profiles WHERE user_id = 'u1'`).first();
    await renameUser(db, "u1", "otter_prime", NOW);
    expect(await renameUser(db, "u1", "otter_again", NOW + DAY)).toEqual({ ok: false, reason: "too_soon" });
    // The plan starts: one change at once.
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'u1'`).bind(NOW + 40 * DAY).run();
    expect(await renameStatus(db, "u1", NOW + DAY)).toEqual({ firstChange: false, nextChangeAt: null, planChange: true, planChangeLeft: true });
    expect(await renameUser(db, "u1", "otter_again", NOW + DAY)).toEqual({ ok: true });
    expect(await used()).toEqual({ plan_rename_at: NOW + DAY, plan_rename: "otter_again" });
    // Used: the usual wait again, from this change.
    expect(await renameStatus(db, "u1", NOW + 2 * DAY)).toEqual({
      firstChange: false,
      nextChangeAt: NOW + 31 * DAY,
      planChange: false,
      planChangeLeft: false,
    });
    expect(await renameUser(db, "u1", "otter_third", NOW + 2 * DAY)).toEqual({ ok: false, reason: "too_soon" });
    expect(await renameUser(db, "u1", "otter_third", NOW + 31 * DAY)).toEqual({ ok: true });
  });

  it("keeps the plan's early change for when it is needed", async () => {
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'u1'`).bind(NOW + 40 * DAY).run();
    // The first change is free anyway, and so is one after the wait.
    expect(await renameUser(db, "u1", "otter_prime", NOW)).toEqual({ ok: true });
    expect(await renameUser(db, "u1", "otter_again", NOW + 30 * DAY)).toEqual({ ok: true });
    expect(await db.prepare(`SELECT plan_rename_at FROM profiles WHERE user_id = 'u1'`).first()).toEqual({ plan_rename_at: null });
    // A short name refused for want of the yearly plan does not use it either.
    expect(await renameUser(db, "u1", "nova", NOW + 31 * DAY)).toEqual({ ok: false, reason: "plan" });
    expect(await db.prepare(`SELECT plan_rename_at FROM profiles WHERE user_id = 'u1'`).first()).toEqual({ plan_rename_at: null });
  });
});

describe("short names and given names", () => {
  beforeEach(async () => {
    await user("fan", "comet", { plan: "year" });
    await user("monthly", "pulse", { plan: true });
    await user("past", "pixel");
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'past'`).bind(NOW - 1).run();
    await user("admin", "boss", { role: "admin" });
  });

  it("keeps a short name with its account when the plan ends or turns monthly", async () => {
    // Nothing swaps it: "pixel" ended, "pulse" is monthly, and both stay.
    expect(await currentName("past")).toBe("pixel");
    expect(await currentName("monthly")).toBe("pulse");
    expect(await accountRecord(db, "past", NOW)).toMatchObject({ fan: false, shortestName: 6, username: "pixel" });
    // But another short one needs the yearly plan again.
    expect(await renameUser(db, "past", "pixie", NOW)).toEqual({ ok: false, reason: "plan" });
  });

  it("keeps 4 characters for the Short username package, bought once, for good, with or without the plan", async () => {
    // The yearly plan allows 5 characters, not 4.
    expect(await renameUser(db, "fan", "nova", NOW)).toEqual({ ok: false, reason: "plan" });
    const bought = { userId: "past", length: 4, sessionId: "cs_name", cents: 25000, currency: "usd", paidAt: NOW, paymentIntent: "pi_name" };
    expect(await grantNameAllowance(db, bought)).toEqual({ granted: true, duplicate: false });
    // From the webhook as well as the return: recorded once, never shared with partners.
    expect(await grantNameAllowance(db, bought)).toEqual({ granted: true, duplicate: false });
    expect((await db.prepare(`SELECT kind, amount_cents FROM payments`).all()).results).toEqual([{ kind: "name", amount_cents: 25000 }]);
    expect(await accountRecord(db, "past", NOW)).toMatchObject({ fan: false, shortestName: 4, nameAllowance: 4 });
    expect(await renameUser(db, "past", "nova", NOW)).toEqual({ ok: true });
    expect(await currentName("past")).toBe("nova");
    // Never bought for an agent; the board's own, run by an admin, may take 4.
    await user("bot", "fan_agent");
    await user("house", "aisha");
    await db.batch([
      db.prepare(`UPDATE profiles SET owner_id = 'fan' WHERE user_id = 'bot'`),
      db.prepare(`UPDATE profiles SET owner_id = 'admin' WHERE user_id = 'house'`),
    ]);
    expect(await grantNameAllowance(db, { ...bought, userId: "bot", sessionId: "cs_bot" })).toEqual({ granted: false, duplicate: false });
    // A second checkout, paid before the first was applied, is a second payment for the same name (review F81).
    expect(await grantNameAllowance(db, { ...bought, sessionId: "cs_again", paidAt: NOW + 60 })).toEqual({ granted: true, duplicate: true });
    // Asked again, the first is still the first.
    expect(await grantNameAllowance(db, bought)).toEqual({ granted: true, duplicate: false });
    // Whatever the order and the second: one applied in the same second
    // with an ID that sorts first is still the second payment.
    expect(await grantNameAllowance(db, { ...bought, sessionId: "cs_a", paidAt: NOW })).toEqual({ granted: true, duplicate: true });
    expect((await db.prepare(`SELECT session_id FROM name_allowances WHERE user_id = 'past'`).all()).results).toEqual([{ session_id: "cs_name" }]);
    expect(await accountRecord(db, "house", NOW)).toMatchObject({ shortestName: 4 });
    expect(await renameUser(db, "house", "aion", NOW)).toEqual({ ok: true });
  });

  it("gives the package's buyer's agent a name of 5 characters, under its owner's rules (owner's decision, 2026-10-20)", async () => {
    await user("bot", "pulse_agent");
    await user("other_bot", "fan_agent");
    await db.batch([
      db.prepare(`UPDATE profiles SET owner_id = 'monthly' WHERE user_id = 'bot'`),
      db.prepare(`UPDATE profiles SET owner_id = 'fan' WHERE user_id = 'other_bot'`),
    ]);
    // Without the package, an agent's name is 6 or more, the yearly plan's owner's too.
    expect(await accountRecord(db, "other_bot", NOW)).toMatchObject({ shortestName: 6 });
    expect(await renameUser(db, "other_bot", "orbit", NOW)).toEqual({ ok: false, reason: "plan" });
    expect(await accountRecord(db, "bot", NOW)).toMatchObject({ shortestName: 6 });
    expect(await renameUser(db, "bot", "astro", NOW)).toEqual({ ok: false, reason: "plan" });

    await grantNameAllowance(db, { userId: "monthly", length: 4, sessionId: "cs_name", cents: 25000, currency: "usd", paidAt: NOW, paymentIntent: "pi_name" });
    expect(await accountRecord(db, "bot", NOW)).toMatchObject({ shortestName: 5 });
    // 5, never 4, and only as often as anyone may change a name.
    expect(await renameUser(db, "bot", "astr", NOW)).toEqual({ ok: false, reason: "plan" });
    expect(await renameUser(db, "bot", "astro", NOW)).toEqual({ ok: true });
    expect(await currentName("bot")).toBe("astro");
    expect(await renameUser(db, "bot", "astra", NOW + DAY)).toEqual({ ok: false, reason: "too_soon" });
  });

  it("lets an admin take a name away, freeing it for its rightful owner", async () => {
    await user("fake", "openai_news");
    expect(await takeName(db, { userId: "fake", actorId: "admin", reason: null, now: NOW })).toMatch(/^[a-z]+_[a-z]+_\d+$/);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM usernames WHERE name = 'openai_news'`).first()).toEqual({ n: 0 });
    expect(await renameUser(db, "fan", "openai_news", NOW)).toEqual({ ok: true });
    expect(await db.prepare(`SELECT action, reason FROM mod_actions`).first()).toEqual({ action: "take_name", reason: "was openai_news" });
  });

  it("takes nothing when the log cannot be written, so every taking is logged", async () => {
    await user("fake", "openai_news");
    await db.prepare(`CREATE TRIGGER refuse_log BEFORE INSERT ON mod_actions BEGIN SELECT RAISE(ABORT, 'no log'); END`).run();
    try {
      await expect(takeName(db, { userId: "fake", actorId: "admin", reason: "Not OpenAI", now: NOW })).rejects.toThrow();
    } finally {
      await db.prepare(`DROP TRIGGER refuse_log`).run();
    }
    expect(await currentName("fake")).toBe("openai_news");
    expect(await takeName(db, { userId: "fake", actorId: "admin", reason: "Not OpenAI", now: NOW })).not.toBeNull();
    expect(await db.prepare(`SELECT reason FROM mod_actions`).first()).toEqual({ reason: "Not OpenAI (was openai_news)" });
  });

  it("checks the plan as a short name is written, not as the page was loaded", async () => {
    // The plan ended after Settings was loaded with it: the write refuses.
    expect(await renameUser(db, "past", "nova", NOW)).toEqual({ ok: false, reason: "plan" });
    expect(await currentName("past")).toBe("pixel");
    // An agent never holds one, whatever its owner's plan.
    await user("bot", "fan_agent");
    await db.prepare(`UPDATE profiles SET owner_id = 'fan' WHERE user_id = 'bot'`).run();
    expect(await renameUser(db, "bot", "beam", NOW)).toEqual({ ok: false, reason: "plan" });
    // A monthly plan is not enough.
    expect(await renameUser(db, "monthly", "nova", NOW)).toEqual({ ok: false, reason: "plan" });
    // A long name needs no plan.
    expect(await renameUser(db, "past", "pixel_long", NOW)).toEqual({ ok: true });
  });
});

describe("bans", () => {
  beforeEach(async () => {
    await user("u1", "quiet_otter_482");
  });

  it("reports a permanent ban with its reason", async () => {
    await db
      .prepare(`UPDATE profiles SET banned_at = ?1, ban_reason = 'Spam' WHERE user_id = 'u1'`)
      .bind(NOW)
      .run();
    expect((await accountRecord(db, "u1", NOW + 365 * DAY))?.ban).toEqual({ kind: "ban", reason: "Spam", until: null });
  });

  it("ends a timed ban by itself", async () => {
    await db
      .prepare(`UPDATE profiles SET banned_at = ?1, banned_until = ?2 WHERE user_id = 'u1'`)
      .bind(NOW, NOW + DAY)
      .run();
    expect((await accountRecord(db, "u1", NOW + DAY - 1))?.ban).toEqual({ kind: "ban", reason: null, until: NOW + DAY });
    expect((await accountRecord(db, "u1", NOW + DAY))?.ban).toBeNull();
  });

  it("participantCondition holds only for an unbanned, undeleted account", async () => {
    const check = async (now: number) =>
      (await db
        .prepare(`SELECT ${participantCondition(1, now)} AS ok`)
        .bind("u1")
        .first<{ ok: number }>())?.ok;
    expect(await check(NOW)).toBe(1);
    await db
      .prepare(`UPDATE profiles SET banned_at = ?1, banned_until = ?2 WHERE user_id = 'u1'`)
      .bind(NOW, NOW + DAY)
      .run();
    expect(await check(NOW)).toBe(0);
    expect(await check(NOW + DAY)).toBe(1);
    await db.prepare(`UPDATE profiles SET banned_at = NULL, deleted_at = ?1 WHERE user_id = 'u1'`).bind(NOW).run();
    expect(await check(NOW)).toBe(0);
  });
});

describe("pagePath", async () => {
  const { pagePath } = await import("../../app/lib/viewer.server");
  it("names the page a data request is for", () => {
    expect(pagePath(new Request("https://aion.ly/submit.data"))).toBe("/submit");
    expect(pagePath(new Request("https://aion.ly/_root.data?_routes=routes%2Fhome"))).toBe("/");
    expect(pagePath(new Request("https://aion.ly/u/otter.data?tab=posts&_routes=x"))).toBe("/u/otter?tab=posts");
    expect(pagePath(new Request("https://aion.ly/settings"))).toBe("/settings");
  });
});

describe("sign-up", async () => {
  const { authFor } = await import("../../app/lib/auth.server");
  const { runWithEndpointContext } = await import("@better-auth/core/context");
  // Sign-up checks run inside a request to the auth endpoints; tests stand one in.
  const adapter = async (invite?: string) => {
    const request = new Request("http://localhost/", invite ? { headers: { Cookie: `aionly_invite=${invite}` } } : {});
    const context = await authFor(request).$context;
    const internal = context.internalAdapter;
    return {
      createUser: (...args: Parameters<typeof internal.createUser>) =>
        runWithEndpointContext({ context } as unknown as Parameters<typeof runWithEndpointContext>[0], () => internal.createUser(...args)),
    };
  };
  const google = { method: "oauth", oauth: { providerId: "google" } } as const;
  // New accounts come by invitation: one from an admin, for each sign-up.
  const invited = async () => {
    const { createInvite } = await import("../../app/lib/db/invites.server");
    await db.prepare(`INSERT OR IGNORE INTO profiles (user_id, role, created_at) VALUES ('signup_host', 'admin', 0)`).run();
    return adapter((await createInvite(db, { inviterId: "signup_host", now: Math.floor(Date.now() / 1000) }))!);
  };

  beforeEach(async () => {
    await db.prepare(`DELETE FROM "user" WHERE "email" LIKE '%@signup.invalid'`).run();
  });

  it("refuses an email Google has not verified", async () => {
    const auth = await adapter();
    await expect(
      auth.createUser({ name: "Someone", email: "someone@signup.invalid", emailVerified: false }, google),
    ).rejects.toMatchObject({ body: { code: "email_not_verified" } });
    const row = await db.prepare(`SELECT 1 FROM "user" WHERE "email" = 'someone@signup.invalid'`).first();
    expect(row).toBeNull();
  });

  it("refuses a Google account whose board account was deleted lately", async () => {
    const { deleteAccount, identityHash } = await import("../../app/lib/db/deletion.server");
    await user("gone", "gone_otter");
    await deleteAccount(db, {
      userId: "gone",
      content: false,
      banned: false,
      identities: [await identityHash(env.BETTER_AUTH_SECRET, "google", "sub-of-gone")],
      now: Math.floor(Date.now() / 1000),
    });
    const auth = await invited();
    const again = { method: "oauth", oauth: { providerId: "google", profile: { sub: "sub-of-gone" } } } as const;
    await expect(
      auth.createUser({ name: "Back again", email: "back@signup.invalid", emailVerified: true }, again),
    ).rejects.toMatchObject({ body: { code: "identity_deleted" } });
    const fresh = { method: "oauth", oauth: { providerId: "google", profile: { sub: "someone-new" } } } as const;
    expect((await (await invited()).createUser({ name: "New", email: "new@signup.invalid", emailVerified: true }, fresh)).email).toBe("new@signup.invalid");
  });

  it("keeps the email lowercased and one account per email", async () => {
    const created = await (await invited()).createUser({ name: "Someone", email: "Someone@Signup.invalid", emailVerified: true }, google);
    expect(created.email).toBe("someone@signup.invalid");
    expect(await currentName(created.id)).toBeDefined();
    await expect(
      (await invited()).createUser({ name: "Twin", email: "SOMEONE@signup.invalid", emailVerified: true }, google),
    ).rejects.toThrow();
  });

  it("makes a new account only with an invitation, which it remembers", async () => {
    await expect(
      (await adapter()).createUser({ name: "Walk-in", email: "walkin@signup.invalid", emailVerified: true }, google),
    ).rejects.toMatchObject({ body: { code: "invite_required" } });
    await expect(
      (await adapter("AAAAAAAA")).createUser({ name: "Guess", email: "guess@signup.invalid", emailVerified: true }, google),
    ).rejects.toMatchObject({ body: { code: "invite_invalid" } });
    const created = await (await invited()).createUser({ name: "Guest", email: "Guest@signup.invalid", emailVerified: true }, google);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = ?1`).bind(created.id).first()).toEqual({ invited_by: "signup_host" });
    // Claimed for this very account, by the ID drawn before it was written.
    expect(await db.prepare(`SELECT used_by, claimed_by FROM invites WHERE used_by = ?1`).bind(created.id).first()).toEqual({
      used_by: created.id,
      claimed_by: created.id,
    });
  });

  it("keeps the digest chosen on the way in with the account, so a profile repaired later starts with it (review F135)", async () => {
    const { createInvite, sweepInviteClaims } = await import("../../app/lib/db/invites.server");
    await db.prepare(`INSERT OR IGNORE INTO profiles (user_id, role, created_at) VALUES ('signup_host', 'admin', 0)`).run();
    const now = Math.floor(Date.now() / 1000);
    const code = (await createInvite(db, { inviterId: "signup_host", now }))!;
    const request = new Request("http://localhost/", { headers: { Cookie: `aionly_invite=${code}; aionly_digest=monthly` } });
    const context = await authFor(request).$context;
    // The profile's own write fails, once the account is written.
    await db.prepare(`CREATE TRIGGER profile_write_fails BEFORE INSERT ON profiles BEGIN SELECT RAISE(ABORT, 'profile write failed'); END`).run();
    try {
      await expect(
        runWithEndpointContext({ context } as unknown as Parameters<typeof runWithEndpointContext>[0], () =>
          context.internalAdapter.createUser({ name: "Monthly", email: "monthly@signup.invalid", emailVerified: true }, google),
        ),
      ).rejects.toThrow();
    } finally {
      await db.prepare(`DROP TRIGGER profile_write_fails`).run();
    }
    const account = (await db.prepare(`SELECT "id", "signupDigest" FROM "user" WHERE "email" = 'monthly@signup.invalid'`).first<{ id: string; signupDigest: string | null }>())!;
    expect(account.signupDigest).toBe("monthly");
    expect(await db.prepare(`SELECT 1 FROM profiles WHERE user_id = ?1`).bind(account.id).first()).toBeNull();

    // The hourly sweep finishes it with that choice, as the next request would (both make it with createProfile).
    await sweepInviteClaims(db, now + 3600);
    expect(await db.prepare(`SELECT digest, invited_by FROM profiles WHERE user_id = ?1`).bind(account.id).first()).toEqual({
      digest: "monthly",
      invited_by: "signup_host",
    });
    // Without a choice, the daily one.
    const plain = await (await invited()).createUser({ name: "Plain", email: "plain@signup.invalid", emailVerified: true }, google);
    expect(await db.prepare(`SELECT digest FROM profiles WHERE user_id = ?1`).bind(plain.id).first()).toEqual({ digest: "daily" });
  });

  it("takes an invitation code in any case, as typed", async () => {
    const { createInvite } = await import("../../app/lib/db/invites.server");
    await db.prepare(`INSERT OR IGNORE INTO profiles (user_id, role, created_at) VALUES ('signup_host', 'admin', 0)`).run();
    const code = (await createInvite(db, { inviterId: "signup_host", now: Math.floor(Date.now() / 1000) }))!;
    const created = await (await adapter(code.toLowerCase())).createUser({ name: "Typist", email: "typist@signup.invalid", emailVerified: true }, google);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = ?1`).bind(created.id).first()).toEqual({ invited_by: "signup_host" });
  });

  it("signs a member in with the X account linked to theirs, as with Google", async () => {
    const created = await (await invited()).createUser({ name: "Member", email: "member@signup.invalid", emailVerified: true }, google);
    const context = await authFor(new Request("http://localhost/")).$context;
    const session = (provider: string) =>
      runWithEndpointContext({ context, params: { id: provider } } as unknown as Parameters<typeof runWithEndpointContext>[0], () =>
        context.internalAdapter.createSession(created.id),
      );
    // X's provider has sign-up off, so this is only ever an account it was linked to.
    expect((await session("twitter"))?.userId).toBe(created.id);
    expect((await session("google"))?.userId).toBe(created.id);
  });

  it("refuses an X account whose board account was deleted lately, should it ever make one", async () => {
    const { deleteAccount, identityHash } = await import("../../app/lib/db/deletion.server");
    await user("gone_x", "gone_x_otter");
    await deleteAccount(db, {
      userId: "gone_x",
      content: false,
      banned: true,
      identities: [await identityHash(env.BETTER_AUTH_SECRET, "twitter", "x-of-gone")],
      now: Math.floor(Date.now() / 1000),
    });
    const again = { method: "oauth", oauth: { providerId: "twitter", profile: { data: { id: "x-of-gone" } } } } as const;
    await expect(
      (await invited()).createUser({ name: "Back", email: "backx@signup.invalid", emailVerified: true }, again),
    ).rejects.toMatchObject({ body: { code: "identity_banned" } });
  });
});

describe("sweepExpiredVerifications", () => {
  it("deletes only sign-in states past their expiry", async () => {
    await db.batch([
      db.prepare(`DELETE FROM "verification"`),
      db.prepare(`INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ('old', 'state', 'x', ?1, ?1, ?1)`).bind("2026-01-01T00:00:00.000Z"),
      db.prepare(`INSERT INTO "verification" ("id", "identifier", "value", "expiresAt", "createdAt", "updatedAt") VALUES ('new', 'state', 'y', ?1, ?1, ?1)`).bind("2026-01-01T00:20:00.000Z"),
    ]);
    expect(await sweepExpiredVerifications(db, new Date("2026-01-01T00:10:00.000Z"))).toBe(1);
    const { results } = await db.prepare(`SELECT "id" FROM "verification"`).all();
    expect(results).toEqual([{ id: "new" }]);
  });
});
