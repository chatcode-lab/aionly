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
  giveName,
  revokeShortNames,
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
    expect(await renameStatus(db, "u1", NOW)).toEqual({ firstChange: true, nextChangeAt: null });
    expect(await renameUser(db, "u1", "otter_prime", NOW)).toEqual({ ok: true });
    expect(await currentName("u1")).toBe("otter_prime");
    expect(await renameUser(db, "u2", "quiet_otter_482", NOW)).toEqual({ ok: false, reason: "taken" });
  });

  it("allows a later change only after 30 days", async () => {
    await renameUser(db, "u1", "otter_prime", NOW);
    expect(await renameStatus(db, "u1", NOW + DAY)).toEqual({
      firstChange: false,
      nextChangeAt: NOW + 30 * DAY,
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
});

describe("short names and given names", () => {
  beforeEach(async () => {
    await user("fan", "neon", { plan: true });
    await user("past", "pixel");
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'past'`).bind(NOW - 1).run();
    await user("admin", "boss", { role: "admin" });
  });

  it("takes back a short name when the plan ends, giving a longer one that counts as no change", async () => {
    expect(await revokeShortNames(db, NOW)).toBe(1);
    expect(await currentName("fan")).toBe("neon");
    expect(await currentName("admin")).toBe("boss");
    const given = (await currentName("past"))!;
    expect(given.length).toBeGreaterThanOrEqual(6);
    // The given name is not the member's change: the first one is still free.
    expect(await renameStatus(db, "past", NOW)).toEqual({ firstChange: true, nextChangeAt: null });
    // The short name stays the account's: its old address leads to the new one.
    expect(await renameUser(db, "fan", "pixel", NOW)).toEqual({ ok: false, reason: "taken" });
    // With the plan again, it can be taken back.
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'past'`).bind(NOW + 30 * DAY).run();
    expect(await renameUser(db, "past", "pixel", NOW + 60)).toEqual({ ok: true });
    expect(await currentName("past")).toBe("pixel");
    expect(await revokeShortNames(db, NOW + 120)).toBe(0);
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
    // A long name needs no plan.
    expect(await renameUser(db, "past", "pixel_long", NOW)).toEqual({ ok: true });
  });

  it("leaves a short name alone when the plan was renewed before the replacement is written", async () => {
    // As the hourly run would, having picked the account before the renewal landed.
    expect(await giveName(db, { userId: "fan", now: NOW, short: true })).toBeNull();
    expect(await currentName("fan")).toBe("neon");
    expect(await giveName(db, { userId: "past", now: NOW, short: true })).not.toBeNull();
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

  it("takes an invitation code in any case, as typed", async () => {
    const { createInvite } = await import("../../app/lib/db/invites.server");
    await db.prepare(`INSERT OR IGNORE INTO profiles (user_id, role, created_at) VALUES ('signup_host', 'admin', 0)`).run();
    const code = (await createInvite(db, { inviterId: "signup_host", now: Math.floor(Date.now() / 1000) }))!;
    const created = await (await adapter(code.toLowerCase())).createUser({ name: "Typist", email: "typist@signup.invalid", emailVerified: true }, google);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = ?1`).bind(created.id).first()).toEqual({ invited_by: "signup_host" });
  });

  it("never signs anyone in with X, which is only linked", async () => {
    const created = await (await invited()).createUser({ name: "Member", email: "member@signup.invalid", emailVerified: true }, google);
    const context = await authFor(new Request("http://localhost/")).$context;
    const session = (provider: string) =>
      runWithEndpointContext({ context, params: { id: provider } } as unknown as Parameters<typeof runWithEndpointContext>[0], () =>
        context.internalAdapter.createSession(created.id),
      );
    await expect(session("twitter")).rejects.toMatchObject({ body: { code: "x_sign_in" } });
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
