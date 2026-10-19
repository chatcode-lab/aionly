import { RouterContextProvider } from "react-router";
import { beforeEach, describe, expect, it } from "vitest";

import { viewerContext } from "../../app/context";
import { addComment } from "../../app/lib/db/authoring.server";
import { deleteAccount } from "../../app/lib/db/deletion.server";
import { editorPick, forgetEditor, nameEditor, pickPost, picksOfTerm, setFocus, unpickPost } from "../../app/lib/db/editors.server";
import { closeVote, fundSummary, nominations, openVote, startVote } from "../../app/lib/db/fund.server";
import {
  claimPartnerJoin,
  createPartnerLink,
  joinedThrough,
  partnerLinks,
  partnersOwed,
  partnerStanding,
  sweepPartnerJoins,
} from "../../app/lib/db/partners.server";
import { recordPayment } from "../../app/lib/db/payments.server";
import { castVote } from "../../app/lib/db/votes.server";
import { sendSignInLink } from "../../app/lib/notices/notices.server";
import { markWelcomed, sendOfferEmails } from "../../app/lib/offers/offers.server";
import { loader as feedMore } from "../../app/routes/feed-more";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

const asUser = async (id: string, email: string) =>
  db
    .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
    .bind(id, email, new Date(NOW * 1000).toISOString())
    .run();

beforeEach(async () => {
  await reset();
  forgetEditor();
  await db.prepare(`DELETE FROM "user"`).run();
  await user("boss", "head_admin", { role: "admin" });
});

describe("partner ledgers (F67, F70, F76)", () => {
  it("keep a deleted member's join and its earned share, and still free a claim that never made an account", async () => {
    await user("star", "guest_star");
    await createPartnerLink(db, { code: "once", partner: "guest_star", steps: [{ percent: 50, months: 12 }], freeInvites: null, maxUses: 1, endsAt: null, note: null, actorId: "boss", now: NOW });
    await claimPartnerJoin(db, { code: "once", userId: "joiner", now: NOW });
    await user("joiner", "joining_member");
    await asUser("joiner", "joiner@example.invalid");
    await recordPayment(db, { id: "in_j", userId: "joiner", kind: "plan", amountCents: 700, currency: "usd", paidAt: NOW + DAY });
    await deleteAccount(db, { userId: "joiner", content: false, banned: false, identities: [], now: NOW + 2 * DAY });
    await claimPartnerJoin(db, { code: "never", userId: "ghost", now: NOW });
    await sweepPartnerJoins(db, NOW + 3 * DAY);
    expect((await db.prepare(`SELECT user_id FROM partner_joins`).all()).results).toEqual([{ user_id: "joiner" }]);
    expect((await partnerStanding(db, "star", NOW + 3 * DAY)).earnedCents).toBe(350);
    // Its one place is still used.
    expect(await claimPartnerJoin(db, { code: "once", userId: "late", now: NOW + 3 * DAY })).toBe(false);
  });

  it("total what partners earned and were paid over the whole ledger, not the lists' latest", async () => {
    await user("star", "guest_star");
    await user("other", "other_partner");
    await createPartnerLink(db, { code: "star", partner: "guest_star", steps: [{ percent: 50, months: 12 }], freeInvites: null, maxUses: null, endsAt: null, note: null, actorId: "boss", now: NOW - DAY });
    await claimPartnerJoin(db, { code: "star", userId: "m1", now: NOW });
    await user("m1", "paying_member");
    await recordPayment(db, { id: "in_m1", userId: "m1", kind: "plan", amountCents: 700, currency: "usd", paidAt: NOW + 60 });
    // Two hundred newer links push the partner's off the admin's list.
    await db.batch(
      Array.from({ length: 200 }, (_, n) =>
        db
          .prepare(`INSERT INTO partner_links (code, partner_id, created_by, created_at) VALUES (?1, 'other', 'boss', ?2)`)
          .bind(`newer-${n}`, NOW + n),
      ),
    );
    await db.batch(
      Array.from({ length: 201 }, (_, n) =>
        db
          .prepare(`INSERT INTO partner_payouts (id, partner_id, amount_cents, currency, paid_on, recorded_by, recorded_at) VALUES (?1, 'star', 1, 'usd', '2026-11-01', 'boss', ?2)`)
          .bind(`p${n}`, NOW),
      ),
    );
    expect((await partnerLinks(db, { now: NOW })).some((link) => link.code === "star")).toBe(false);
    expect((await partnersOwed(db, NOW)).find((partner) => partner.partnerId === "star")).toMatchObject({ earnedCents: 350, paidCents: 201 });
    expect(await partnerStanding(db, "star", NOW)).toMatchObject({ earnedCents: 350, paidCents: 201 });
  });

  it("list who joined through a link of any valid name, `constructor` included", async () => {
    await createPartnerLink(db, { code: "constructor", partner: "head_admin", steps: [{ percent: 0, months: 12 }], freeInvites: null, maxUses: null, endsAt: null, note: null, actorId: "boss", now: NOW });
    await claimPartnerJoin(db, { code: "constructor", userId: "j1", now: NOW });
    await user("j1", "first_joiner");
    const joined = new Map(await joinedThrough(db, ["constructor"]));
    expect(joined.get("constructor")?.map((member) => member.username)).toEqual(["first_joiner"]);
  });
});

describe("guest editors' writes (F68, F69, F71, F72)", () => {
  beforeEach(async () => {
    await user("ed", "guest_editor");
    for (const id of ["pa00001", "pb00001", "pc00001"]) await post(id, { author: "boss" });
    await nameEditor(db, { username: "guest_editor", startsAt: NOW - DAY, endsAt: NOW + 6 * DAY, actorId: "boss", now: NOW });
  });

  it("refuse an editor at the karma floor, in the write itself", async () => {
    await db.prepare(`UPDATE profiles SET karma = -200 WHERE user_id = 'ed'`).run();
    expect(await pickPost(db, { editorId: "ed", postId: "pa00001", note: null, now: NOW })).toEqual({ ok: false, reason: "not_editor" });
    expect(await setFocus(db, { editorId: "ed", focus: "Late focus", now: NOW })).toBe(false);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM picks`).first())!.n).toBe(0);
  });

  it("refuse a ban that lands between the term's read and the write", async () => {
    // The batch runs after the ban: the read saw a running term.
    const banning = new Proxy(db, {
      get(target, property) {
        if (property === "batch") {
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'ed'`).bind(NOW).run();
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    expect(await pickPost(banning, { editorId: "ed", postId: "pa00001", note: null, now: NOW })).toEqual({ ok: false, reason: "not_editor" });
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM pins WHERE slot = 'pick'`).first())!.n).toBe(0);
  });

  it("pin the term's latest live pick when one is taken back, and list only live picks", async () => {
    await pickPost(db, { editorId: "ed", postId: "pa00001", note: "A", now: NOW });
    await pickPost(db, { editorId: "ed", postId: "pb00001", note: "B", now: NOW + 60 });
    await pickPost(db, { editorId: "ed", postId: "pc00001", note: "C", now: NOW + 120 });
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1' WHERE id = 'pb00001'`).run();
    expect(await unpickPost(db, { editorId: "ed", postId: "pc00001", now: NOW + 180 })).toEqual({ ok: true });
    expect(await editorPick(db, NOW + 200)).toMatchObject({ post: { id: "pa00001" }, note: "A" });
    const term = (await editorPick(db, NOW + 200))!.term;
    expect((await picksOfTerm(db, term.id)).map((pick) => pick.postId)).toEqual(["pa00001"]);
  });

  it("leave the pinned pick out of New's next pages", async () => {
    // The route reads the clock: the term runs now.
    const now = Math.floor(Date.now() / 1000);
    await db.prepare(`UPDATE editor_terms SET starts_at = ?1, ends_at = ?2`).bind(now - DAY, now + DAY).run();
    expect(await pickPost(db, { editorId: "ed", postId: "pa00001", note: null, now })).toEqual({ ok: true });
    const context = new RouterContextProvider();
    context.set(viewerContext, async () => null);
    const response = (await feedMore({
      request: new Request("https://aion.ly/feed/more?sort=new&range=all"),
      context,
      params: {},
    } as unknown as Parameters<typeof feedMore>[0])) as Response;
    const page = (await response.json()) as { posts: Array<{ id: string }> };
    expect(page.posts.map((card) => card.id)).not.toContain("pa00001");
    expect(page.posts.map((card) => card.id)).toContain("pb00001");
  });
});

describe("fund votes (F74, F75)", () => {
  beforeEach(async () => {
    await user("u1", "member_one");
    await user("u2", "member_two");
    await post("vote01a", { author: "boss", title: "Where should the fund give?" });
    await startVote(db, { postId: "vote01a", closesAt: NOW + DAY, actorId: "boss", now: NOW });
  });

  it("show a vote post's title only while it is live, and let an admin close it", async () => {
    expect((await fundSummary(db, NOW)).vote?.post?.title).toBe("Where should the fund give?");
    await db.prepare(`UPDATE posts SET removed_batch_id = 'b1' WHERE id = 'vote01a'`).run();
    const hidden = await fundSummary(db, NOW);
    expect(hidden.vote).toMatchObject({ postId: "vote01a", post: null });
    expect(JSON.stringify(hidden)).not.toContain("Where should the fund give?");
    expect(await closeVote(db, NOW)).toBe(true);
    expect(await openVote(db, NOW)).toBeNull();
  });

  it("take no nomination and no vote on one after the close; replies go on", async () => {
    await comment("n1", { post: "vote01a", author: "u1", body: "A cause", score: 0 });
    const late = NOW + 2 * DAY;
    expect(await addComment(db, { id: "n2", postId: "vote01a", parentId: null, authorId: "u2", body: "Too late", now: late })).toEqual({
      ok: false,
      reason: "nominations_closed",
    });
    expect(await castVote(db, { voterId: "u2", type: "comment", targetId: "n1", value: 1, now: late })).toEqual({ ok: false, reason: "closed" });
    expect(await addComment(db, { id: "r1", postId: "vote01a", parentId: "n1", authorId: "u2", body: "Still talking", now: late })).toEqual({ ok: true });
    expect((await nominations(db, "vote01a")).map((entry) => entry.id)).toEqual(["n1"]);
    expect((await openVote(db, late))?.closed).toBe(true);
    // Before the close, both work.
    expect(await castVote(db, { voterId: "u2", type: "comment", targetId: "n1", value: 1, now: NOW + 60 })).toMatchObject({ ok: true });
  });
});

describe("sign-in links' hourly limit (F73)", () => {
  it("counts sends in its own ledger, which outlives the links", async () => {
    await user("m1", "link_member");
    await asUser("m1", "member@aion.ly");
    const sent: string[] = [];
    const mailer = { send: async (mail: { to: string }) => void sent.push(mail.to) };
    const link = { email: "member@aion.ly", url: "https://aion.ly/signin/email?token=t", origin: "https://aion.ly", secret: "s" };
    for (const at of [0, 60, 120]) expect(await sendSignInLink(db, mailer, { ...link, now: NOW + at })).toBe(true);
    // The links themselves gone, as the sweep removes them: still no fourth this hour.
    await db.prepare(`DELETE FROM "verification"`).run();
    expect(await sendSignInLink(db, mailer, { ...link, now: NOW + 1800 })).toBe(false);
    expect(await sendSignInLink(db, mailer, { ...link, now: NOW + 3601 })).toBe(true);
    expect(sent).toHaveLength(4);
    // Kept as a keyed hash, never the address.
    expect(JSON.stringify((await db.prepare(`SELECT * FROM sign_in_link_sends`).all()).results)).not.toContain("member@aion.ly");
  });
});

describe("offers wait for the welcome step (F60)", () => {
  it("go only after the welcome, and not when turned down there", async () => {
    const sent: string[] = [];
    const mailer = { send: async (mail: { to: string }) => void sent.push(mail.to) };
    for (const id of ["w1", "w2"]) {
      await user(id, `new_member_${id}`);
      await db.prepare(`UPDATE profiles SET created_at = ?2, welcomed_at = NULL WHERE user_id = ?1`).bind(id, NOW - 60).run();
      await asUser(id, `${id}@aion.ly`);
    }
    const input = { origin: "https://aion.ly", secret: "s", now: NOW };
    expect(await sendOfferEmails(db, mailer, input)).toBe(0);
    await markWelcomed(db, "w1", { offersOff: false, now: NOW });
    await markWelcomed(db, "w2", { offersOff: true, now: NOW });
    expect(await sendOfferEmails(db, mailer, input)).toBe(1);
    expect(sent).toEqual(["w1@aion.ly"]);
  });
});
