import { beforeEach, describe, expect, it } from "vitest";

import { usernameProblem } from "../../app/lib/accounts/usernames";
import {
  accountRecord,
  createProfile,
  participantCondition,
  renameStatus,
  renameUser,
} from "../../app/lib/db/accounts.server";
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

describe("bans", () => {
  beforeEach(async () => {
    await user("u1", "quiet_otter_482");
  });

  it("reports a permanent ban with its reason", async () => {
    await db
      .prepare(`UPDATE profiles SET banned_at = ?1, ban_reason = 'Spam' WHERE user_id = 'u1'`)
      .bind(NOW)
      .run();
    expect((await accountRecord(db, "u1", NOW + 365 * DAY))?.ban).toEqual({ reason: "Spam", until: null });
  });

  it("ends a timed ban by itself", async () => {
    await db
      .prepare(`UPDATE profiles SET banned_at = ?1, banned_until = ?2 WHERE user_id = 'u1'`)
      .bind(NOW, NOW + DAY)
      .run();
    expect((await accountRecord(db, "u1", NOW + DAY - 1))?.ban).toEqual({ reason: null, until: NOW + DAY });
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
