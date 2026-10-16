import { beforeEach, describe, expect, it } from "vitest";

import {
  attachPartner,
  claimPartnerJoin,
  createPartnerLink,
  partnerLinkByCode,
  partnerLinks,
  partnersOwed,
  partnerStanding,
  recordPayout,
  revokePartnerLink,
  sweepPartnerJoins,
} from "../../app/lib/db/partners.server";
import { recordPayment } from "../../app/lib/db/payments.server";
import { normalizePartnerCode, shareWords } from "../../app/lib/partners";
import { DAY, db, NOW, reset, user } from "./fixtures";

const link = (code: string, fields: Partial<Parameters<typeof createPartnerLink>[1]> = {}) =>
  createPartnerLink(db, {
    code,
    partner: "guest_star",
    sharePercent: 50,
    shareMonths: 12,
    maxUses: null,
    endsAt: null,
    note: null,
    actorId: "boss",
    now: NOW,
    ...fields,
  });

/** An account that joined through `code` at `at`, as a sign-up would make it. */
async function joined(id: string, code: string, at = NOW): Promise<boolean> {
  const claimed = await claimPartnerJoin(db, { code, userId: id, now: at });
  if (!claimed) return false;
  await user(id, `member_${id}`);
  await db
    .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
    .bind(id, `${id}@example.invalid`, new Date(at * 1000).toISOString())
    .run();
  await attachPartner(db, { userId: id });
  return true;
}

describe("partner links", () => {
  beforeEach(async () => {
    await reset();
    await db.prepare(`DELETE FROM "user"`).run();
    await user("boss", "head_admin", { role: "admin" });
    await user("star", "guest_star");
  });

  it("are made for a member's account, with a name of their own", async () => {
    expect(await link("star")).toBeNull();
    expect(await link("star")).toBe("taken");
    expect(await link("other", { partner: "nobody_here" })).toBe("no_partner");
    expect(normalizePartnerCode(" Star_AI ")).toBe("star_ai");
    expect(normalizePartnerCode("x")).toBeNull();
    expect(normalizePartnerCode("../admin")).toBeNull();
    expect(shareWords({ percent: 50, months: 12 })).toBe("half of what they pay for the Fan plan in their first year");
  });

  it("make many accounts, each invited by the partner, up to the link's limit", async () => {
    await link("star", { maxUses: 2 });
    expect(await joined("a", "star")).toBe(true);
    expect(await joined("b", "star")).toBe(true);
    expect(await joined("c", "star")).toBe(false);
    expect((await partnerLinkByCode(db, "star", NOW))?.state).toBe("full");
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = 'a'`).first()).toEqual({ invited_by: "star" });
    // The partner's profile counts them, as invitations do.
    expect(await db.prepare(`SELECT COUNT(*) AS invited FROM profiles WHERE invited_by = 'star'`).first()).toEqual({ invited: 2 });
  });

  it("stop when revoked, past their end, or while the partner is banned", async () => {
    await link("ends", { endsAt: NOW + DAY });
    await link("gone");
    expect((await partnerLinkByCode(db, "ends", NOW))?.state).toBe("open");
    expect((await partnerLinkByCode(db, "ends", NOW + 2 * DAY))?.state).toBe("ended");
    expect(await claimPartnerJoin(db, { code: "ends", userId: "late", now: NOW + 2 * DAY })).toBe(false);
    expect(await revokePartnerLink(db, { code: "gone", now: NOW })).toBe(true);
    expect((await partnerLinkByCode(db, "gone", NOW))?.state).toBe("revoked");
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'star'`).bind(NOW).run();
    expect((await partnerLinkByCode(db, "ends", NOW))?.state).toBe("paused");
    expect(await partnerLinkByCode(db, "missing", NOW)).toBeNull();
  });

  it("share what members pay for the plan in their first months, before tax and less refunds", async () => {
    await link("star", { shareMonths: 3 });
    await joined("a", "star", NOW);
    await joined("b", "star", NOW);
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'a'`).bind(NOW + 30 * DAY).run();
    const pay = (id: string, userId: string, cents: number, at: number, kind: "plan" | "fresh_start" = "plan") =>
      recordPayment(db, { id, userId, kind, amountCents: cents, currency: "usd", paidAt: at });
    await pay("in_a1", "a", 700, NOW + DAY);
    await pay("in_a2", "a", 700, NOW + 40 * DAY);
    // After the three months, and a fresh start, which goes to the fund: not shared.
    await pay("in_a3", "a", 700, NOW + 100 * DAY);
    await pay("cs_b", "b", 2000, NOW + DAY, "fresh_start");
    await db.prepare(`UPDATE payments SET refunded_cents = 200 WHERE id = 'in_a2'`).run();
    // Paid before joining through the link: not shared either.
    await user("early", "early_member");
    await pay("in_early", "early", 7000, NOW - DAY);
    await db.prepare(`INSERT INTO partner_joins (user_id, code, joined_at) VALUES ('early', 'star', ?1)`).bind(NOW).run();

    const [stats] = await partnerLinks(db, { now: NOW + 2 * DAY });
    expect(stats).toMatchObject({ code: "star", joined: 3, fans: 1, revenueCents: 1200, earnedCents: 600, live: true });
    await recordPayout(db, { partnerId: "star", amountCents: 250, paidOn: "2026-11-01", note: "PayPal", actorId: "boss", now: NOW });
    expect(await partnersOwed(db, NOW)).toEqual([{ partnerId: "star", partner: "guest_star", earnedCents: 600, paidCents: 250 }]);
    const standing = await partnerStanding(db, "star", NOW);
    expect(standing).toMatchObject({ earnedCents: 600, paidCents: 250 });
    expect(standing.payouts).toEqual([{ id: expect.any(String), paidOn: "2026-11-01", amountCents: 250, note: "PayPal" }]);
  });

  it("drop claims whose account never came, and finish those whose step failed", async () => {
    await link("star");
    expect(await claimPartnerJoin(db, { code: "star", userId: "never", now: NOW })).toBe(true);
    expect(await claimPartnerJoin(db, { code: "star", userId: "half", now: NOW })).toBe(true);
    await user("half", "half_member");
    await db
      .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES ('half', 'n', 'half@example.invalid', 1, ?1, ?1)`)
      .bind(new Date(NOW * 1000).toISOString())
      .run();
    expect(await sweepPartnerJoins(db, NOW + 3600)).toBe(2);
    expect((await db.prepare(`SELECT user_id FROM partner_joins ORDER BY user_id`).all()).results).toEqual([{ user_id: "half" }]);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = 'half'`).first()).toEqual({ invited_by: "star" });
  });
});

describe("sign-up through a partner's link", async () => {
  const { authFor } = await import("../../app/lib/auth.server");
  const { runWithEndpointContext } = await import("@better-auth/core/context");
  const adapter = async (cookie: string) => {
    const context = await authFor(new Request("http://localhost/", { headers: { Cookie: cookie } })).$context;
    const internal = context.internalAdapter;
    return {
      createUser: (...args: Parameters<typeof internal.createUser>) =>
        runWithEndpointContext({ context } as unknown as Parameters<typeof runWithEndpointContext>[0], () => internal.createUser(...args)),
    };
  };
  const google = { method: "oauth", oauth: { providerId: "google" } } as const;

  beforeEach(async () => {
    await reset();
    await db.prepare(`DELETE FROM "user"`).run();
    await user("boss", "head_admin", { role: "admin" });
    await user("star", "guest_star");
  });

  it("lets a new account in, invited by the partner, while the link works", async () => {
    await createPartnerLink(db, { code: "star", partner: "guest_star", sharePercent: 50, shareMonths: 12, maxUses: 1, endsAt: null, note: null, actorId: "boss", now: NOW });
    const created = await (await adapter("aionly_partner=star")).createUser({ name: "Fan", email: "fan@signup.invalid", emailVerified: true }, google);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = ?1`).bind(created.id).first()).toEqual({ invited_by: "star" });
    expect(await db.prepare(`SELECT code FROM partner_joins WHERE user_id = ?1`).bind(created.id).first()).toEqual({ code: "star" });
    // Its one account made, the link is full.
    await expect(
      (await adapter("aionly_partner=star")).createUser({ name: "Late", email: "late@signup.invalid", emailVerified: true }, google),
    ).rejects.toMatchObject({ body: { code: "invite_invalid" } });
  });
});
