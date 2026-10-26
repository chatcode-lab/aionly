import { beforeEach, describe, expect, it } from "vitest";

import {
  attachPartner,
  claimPartnerJoin,
  createPartnerLink,
  forgetSharedJoin,
  partnerLinkByCode,
  partnerLinks,
  partnersOwed,
  partnerStanding,
  recordPayout,
  revokePartnerLink,
  sharedJoin,
  sharedJoinCode,
  sweepPartnerJoins,
} from "../../app/lib/db/partners.server";
import { recordPayment } from "../../app/lib/db/payments.server";
import { normalizePartnerCode, partnerStepsProblem, shareWords, stepsLabel } from "../../app/lib/partners";
import { DAY, db, NOW, reset, user } from "./fixtures";

const link = (code: string, fields: Partial<Parameters<typeof createPartnerLink>[1]> = {}) =>
  createPartnerLink(db, {
    code,
    partner: "guest_star",
    steps: [{ percent: 50, months: 12 }], freeInvites: null,
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
    expect(shareWords([{ percent: 50, months: 12 }])).toBe("half of what they pay for the Fan plan in their first year");
  });

  it("share in steps, the last of which may last for good", () => {
    const steps = [
      { percent: 100, months: 12 },
      { percent: 50, months: null },
    ];
    expect(shareWords(steps)).toBe("all of what they pay for the Fan plan in their first year, then half for as long as they have it");
    expect(stepsLabel(steps)).toBe("100% for 12 months, then 50% for good");
    expect(partnerStepsProblem(steps)).toBeNull();
    expect(partnerStepsProblem([])).toBe("Give the share of at least one step.");
    expect(partnerStepsProblem([{ percent: 50, months: null }, { percent: 10, months: 12 }])).toBe("Only the last step can last for good.");
    expect(partnerStepsProblem([{ percent: 101, months: 12 }])).toBe("Each share is a whole percent, 0 to 100.");
    expect(partnerStepsProblem([{ percent: Number.NaN, months: 12 }])).toBe("Each share is a whole percent, 0 to 100.");
    expect(partnerStepsProblem([{ percent: 50, months: 0 }])).toMatch(/1 to 120 months/);
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
    await link("star", { steps: [{ percent: 50, months: 3 }] });
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

  it("share each payment at the step it falls in: all the first year, then half for good", async () => {
    await link("star", {
      steps: [
        { percent: 100, months: 12 },
        { percent: 50, months: null },
      ],
    });
    await joined("a", "star", NOW);
    const pay = (id: string, cents: number, at: number, kind: "plan" | "name" = "plan") =>
      recordPayment(db, { id, userId: "a", kind, amountCents: cents, currency: "usd", paidAt: at });
    await pay("in_1", 7000, NOW + DAY);
    await pay("in_2", 7000, NOW + 370 * DAY);
    await pay("in_3", 7000, NOW + 1500 * DAY);
    // A 4-letter username is never shared.
    await pay("cs_name", 25000, NOW + DAY, "name");
    const [stats] = await partnerLinks(db, { now: NOW + 1600 * DAY });
    expect(stats).toMatchObject({
      steps: [
        { percent: 100, months: 12 },
        { percent: 50, months: null },
      ],
      revenueCents: 21000,
      earnedCents: 7000 + 3500 + 3500,
    });
    expect(await partnersOwed(db, NOW)).toEqual([{ partnerId: "star", partner: "guest_star", earnedCents: 14000, paidCents: 0 }]);
    expect((await partnerLinkByCode(db, "star", NOW))?.steps).toEqual(stats!.steps);
  });

  it("give those who join the link's free invitations, a level below the partner", async () => {
    await link("none", { freeInvites: 0 });
    await link("level", { code: "level", freeInvites: null });
    await db.prepare(`UPDATE profiles SET invite_depth = 2 WHERE user_id = 'star'`).run();
    await joined("a", "none");
    await joined("b", "level");
    expect(await db.prepare(`SELECT invite_depth, free_invites FROM profiles WHERE user_id = 'a'`).first()).toEqual({ invite_depth: 3, free_invites: 0 });
    expect(await db.prepare(`SELECT invite_depth, free_invites FROM profiles WHERE user_id = 'b'`).first()).toEqual({ invite_depth: 3, free_invites: null });
    expect((await partnerLinks(db, { now: NOW })).map((made) => [made.code, made.freeInvites])).toEqual(
      expect.arrayContaining([
        ["none", 0],
        ["level", null],
      ]),
    );
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

describe("the link offered to anyone signing up (owner's request, 2026-10-21)", () => {
  beforeEach(async () => {
    await reset();
    forgetSharedJoin();
    await user("boss", "head_admin", { role: "admin" });
    await user("founder", "boris");
  });

  it("is offered while it is open, and not once it is revoked, as of the next minute", async () => {
    expect(await sharedJoinCode(db, NOW * 1000)).toBeNull();
    forgetSharedJoin();
    expect(await link("boris", { partner: "boris" })).toBeNull();
    expect(await sharedJoinCode(db, NOW * 1000)).toBe("boris");
    expect(await revokePartnerLink(db, { code: "boris", now: NOW })).toBe(true);
    // Kept a minute per instance, then asked again.
    expect(await sharedJoinCode(db, NOW * 1000 + 30_000)).toBe("boris");
    expect(await sharedJoinCode(db, NOW * 1000 + 61_000)).toBeNull();
  });

  it("comes with the founder's picture, for the invitation to the digest", async () => {
    expect(await link("boris", { partner: "boris" })).toBeNull();
    expect(await sharedJoin(db, NOW * 1000)).toEqual({ code: "boris", founderAvatar: null });
    await db.prepare(`UPDATE profiles SET avatar_key = 'founder.jpg' WHERE user_id = 'founder'`).run();
    forgetSharedJoin();
    expect(await sharedJoin(db, NOW * 1000)).toEqual({ code: "boris", founderAvatar: "founder.jpg" });
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
    await createPartnerLink(db, { code: "star", partner: "guest_star", steps: [{ percent: 50, months: 12 }], freeInvites: null, maxUses: 1, endsAt: null, note: null, actorId: "boss", now: NOW });
    const created = await (await adapter("aionly_partner=star")).createUser({ name: "Fan", email: "fan@signup.invalid", emailVerified: true }, google);
    expect(await db.prepare(`SELECT invited_by FROM profiles WHERE user_id = ?1`).bind(created.id).first()).toEqual({ invited_by: "star" });
    expect(await db.prepare(`SELECT code FROM partner_joins WHERE user_id = ?1`).bind(created.id).first()).toEqual({ code: "star" });
    // Its one account made, the link is full.
    await expect(
      (await adapter("aionly_partner=star")).createUser({ name: "Late", email: "late@signup.invalid", emailVerified: true }, google),
    ).rejects.toMatchObject({ body: { code: "invite_invalid" } });
  });

  it("starts the account with the digest chosen on the way in, or the daily one", async () => {
    await createPartnerLink(db, { code: "star", partner: "guest_star", steps: [{ percent: 50, months: 12 }], freeInvites: null, maxUses: null, endsAt: null, note: null, actorId: "boss", now: NOW });
    const digestOf = async (id: string) => (await db.prepare(`SELECT digest FROM profiles WHERE user_id = ?1`).bind(id).first<{ digest: string | null }>())?.digest;
    const weekly = await (await adapter("aionly_partner=star; aionly_digest=weekly")).createUser({ name: "Weekly", email: "weekly@signup.invalid", emailVerified: true }, google);
    expect(await digestOf(weekly.id)).toBe("weekly");
    // Anything else is not a choice.
    const odd = await (await adapter("aionly_partner=star; aionly_digest=hourly")).createUser({ name: "Odd", email: "odd@signup.invalid", emailVerified: true }, google);
    expect(await digestOf(odd.id)).toBe("daily");
  });
});
