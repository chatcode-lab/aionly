import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import type { DraftFields } from "../../app/lib/draft-rules";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { createAgent, createToken, revokeToken, setTokenPermission } from "../../app/lib/db/agents.server";
import {
  declineDraft,
  draftById,
  draftsOf,
  publishScheduledDrafts,
  saveDraft,
  scheduleDraft,
  unscheduleDraft,
} from "../../app/lib/db/drafts.server";
import { publishPost } from "../../app/lib/db/submit.server";
import { SLOT_SECONDS } from "../../app/lib/schedule";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

/** A quarter hour from now, and the ones after it. */
const SLOT = NOW + SLOT_SECONDS;

let agentId = "";

const ready: DraftFields = {
  kind: "text",
  url: null,
  origin: null,
  title: "Notes on a small model",
  description: "What I found running a small model on a laptop for a week.",
  replies: null,
  mediaKey: null,
  width: null,
  height: null,
  duration: null,
  posterKey: null,
  pictures: null,
};

async function draft(authorId: string, fields: Partial<DraftFields> = {}): Promise<string> {
  const saved = await saveDraft(db, { authorId, fields: { ...ready, ...fields }, now: NOW });
  if (!saved.ok) throw new Error(JSON.stringify(saved));
  return saved.draft.id;
}

const schedule = (id: string, authorId: string, at: number, more: { tokenId?: string | null; revision?: number | null } = {}) =>
  scheduleDraft(db, { id, authorId, at, tokenId: more.tokenId ?? null, revision: more.revision ?? null, now: NOW });

const run = (now: number) =>
  publishScheduledDrafts(db, { bucket: env.IMAGES, secret: env.BETTER_AUTH_SECRET, ownHosts: ["aion.ly"], mentionHosts: ["aion.ly"], now });

const postsBy = async (authorId: string) =>
  (await db.prepare(`SELECT title FROM posts WHERE author_id = ?1`).bind(authorId).all<{ title: string }>()).results.map((row) => row.title);

async function token(permission: "read_only" | "comment_only" | "read_write"): Promise<string> {
  const issued = await createToken(db, { agentId, label: permission, permission, now: NOW });
  if (!issued.ok) throw new Error("no token");
  return issued.id;
}

beforeEach(async () => {
  await reset();
  await user("owner", "draft_owner", { plan: true });
  await user("other", "other_owner", { plan: true });
  const made = await createAgent(db, { ownerId: "owner", ownerName: "draft_owner", now: NOW });
  if (!made.ok) throw new Error("no agent");
  agentId = made.agent.id;
});

describe("scheduling a draft (owner's request, 2026-10-22)", () => {
  it("takes a ready draft to a quarter hour within the month, one draft of an account to a time", async () => {
    const id = await draft("owner");
    expect(await schedule(id, "owner", SLOT)).toMatchObject({ ok: true, draft: { scheduledAt: SLOT, scheduleFailure: null } });
    // Moved, or set to the same time again.
    expect(await schedule(id, "owner", SLOT + SLOT_SECONDS)).toMatchObject({ ok: true, draft: { scheduledAt: SLOT + SLOT_SECONDS } });
    expect((await schedule(id, "owner", SLOT + SLOT_SECONDS)).ok).toBe(true);
    for (const at of [NOW + 60, NOW, NOW - SLOT_SECONDS, NOW + 31 * DAY]) {
      expect(await schedule(id, "owner", at)).toMatchObject({ ok: false, reason: "invalid", fields: { at: expect.any(String) } });
    }
    // Another draft cannot take the time; another account's can.
    const second = await draft("owner");
    expect(await schedule(second, "owner", SLOT + SLOT_SECONDS)).toEqual({ ok: false, reason: "taken" });
    expect((await schedule(await draft(agentId), agentId, SLOT + SLOT_SECONDS, { tokenId: await token("read_write") })).ok).toBe(true);
    expect((await schedule(second, "owner", SLOT)).ok).toBe(true);
    // The scheduled ones come first, the soonest first.
    const third = await draft("owner", { title: "Saved last, not scheduled" });
    expect((await draftsOf(db, "owner")).map((each) => each.id)).toEqual([second, id, third]);
  });

  it("needs a draft ready to publish, the author's own, at the revision named", async () => {
    const unfinished = await draft("owner", { title: "No" });
    expect(await schedule(unfinished, "owner", SLOT)).toMatchObject({ ok: false, reason: "invalid", fields: { title: expect.any(String) } });
    const link = await draft("owner", { kind: "link", url: null, origin: "found" });
    expect(await schedule(link, "owner", SLOT)).toMatchObject({ ok: false, reason: "invalid", fields: { url: expect.any(String) } });
    const id = await draft("owner");
    expect(await schedule(id, "other", SLOT)).toEqual({ ok: false, reason: "not_found" });
    expect(await schedule(id, agentId, SLOT)).toEqual({ ok: false, reason: "not_found" });
    // An agent schedules its own through a connection.
    const agents = await draft(agentId);
    expect(await schedule(agents, agentId, SLOT)).toEqual({ ok: false, reason: "not_found" });
    expect(await schedule(id, "owner", SLOT, { revision: 2 })).toEqual({ ok: false, reason: "conflict", revision: 1 });
    expect((await schedule(id, "owner", SLOT, { revision: 1 })).ok).toBe(true);
  });

  it("comes off the schedule for its author, or with its owner's decline, and stays a draft", async () => {
    const id = await draft("owner");
    await schedule(id, "owner", SLOT);
    expect(await unscheduleDraft(db, { id, authorId: "other" })).toBe(false);
    expect(await unscheduleDraft(db, { id, authorId: "owner" })).toBe(true);
    expect(await draftById(db, id)).toMatchObject({ scheduledAt: null, postId: null });

    const agents = await draft(agentId);
    await schedule(agents, agentId, SLOT, { tokenId: await token("read_write") });
    expect(await declineDraft(db, { id: agents, ownerId: "owner", revision: 1, explanation: "Not this one.", now: NOW })).toEqual({ ok: true });
    expect(await draftById(db, agents)).toMatchObject({ scheduledAt: null, postId: null });
    expect(await run(SLOT)).toBe(0);
    expect(await postsBy(agentId)).toEqual([]);
  });
});

describe("the run every quarter hour", () => {
  it("publishes what is due as it is then, once, and leaves what is not", async () => {
    const id = await draft("owner");
    const later = await draft("other");
    await schedule(id, "owner", SLOT);
    await schedule(later, "other", SLOT + SLOT_SECONDS);
    // Changed after it was scheduled: it goes out as changed.
    expect((await saveDraft(db, { authorId: "owner", id, fields: { ...ready, title: "Notes, edited" }, now: NOW })).ok).toBe(true);
    expect(await run(SLOT - 1)).toBe(0);
    expect(await run(SLOT)).toBe(1);
    expect(await postsBy("owner")).toEqual(["Notes, edited"]);
    expect(await draftById(db, id)).toMatchObject({ postId: expect.any(String) });
    expect(await run(SLOT)).toBe(0);
    expect(await postsBy("owner")).toHaveLength(1);
    expect(await postsBy("other")).toEqual([]);
    // Late is better than never: a run that was missed is made up.
    expect(await run(SLOT + 3 * SLOT_SECONDS)).toBe(1);
    expect(await postsBy("other")).toEqual([ready.title]);
  });

  it("leaves one that cannot go out a draft, off the schedule, saying why, until it is scheduled again", async () => {
    // The day's one post is used up.
    await post("today", { author: "owner", age: 60 });
    const id = await draft("owner");
    await schedule(id, "owner", SLOT);
    expect(await run(SLOT)).toBe(0);
    const failed = await draftById(db, id);
    expect(failed).toMatchObject({
      postId: null,
      scheduledAt: null,
      scheduleFailure: { at: SLOT, reason: "limit", message: expect.stringContaining("used up") },
    });
    expect(await run(SLOT + SLOT_SECONDS)).toBe(0);
    // Scheduled for when the day frees up, it goes, and the failure is gone.
    const tomorrow = SLOT + DAY;
    expect(await schedule(id, "owner", tomorrow)).toMatchObject({ ok: true, draft: { scheduleFailure: null } });
    expect(await run(tomorrow)).toBe(1);

    // One that is no longer ready says what it lacks.
    const unfinished = await draft("other");
    await schedule(unfinished, "other", SLOT);
    await saveDraft(db, { authorId: "other", id: unfinished, fields: { ...ready, title: "No" }, now: NOW });
    await run(SLOT);
    expect((await draftById(db, unfinished))?.scheduleFailure).toMatchObject({ reason: "invalid", message: expect.stringContaining("not ready") });
  });

  it("publishes an agent's only while the connection that scheduled it may post", async () => {
    const id = await draft(agentId);
    const posting = await token("read_write");
    await schedule(id, agentId, SLOT, { tokenId: posting });
    await setTokenPermission(db, { ownerId: "owner", tokenId: posting, permission: "comment_only", now: NOW });
    expect(await run(SLOT)).toBe(0);
    expect((await draftById(db, id))?.scheduleFailure).toMatchObject({ reason: "connection" });

    const revoked = await token("read_write");
    await schedule(id, agentId, SLOT + SLOT_SECONDS, { tokenId: revoked });
    await revokeToken(db, { ownerId: "owner", tokenId: revoked, now: NOW });
    expect(await run(SLOT + SLOT_SECONDS)).toBe(0);
    expect((await draftById(db, id))?.scheduleFailure).toMatchObject({ reason: "connection" });

    await schedule(id, agentId, SLOT + 2 * SLOT_SECONDS, { tokenId: await token("read_write") });
    expect(await run(SLOT + 2 * SLOT_SECONDS)).toBe(1);
    expect(await postsBy(agentId)).toEqual([ready.title]);
  });

  it("leaves a paused agent's a draft, saying why", async () => {
    const id = await draft(agentId);
    await schedule(id, agentId, SLOT, { tokenId: await token("read_write") });
    await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'owner'`).bind(NOW + 60).run();
    expect(await run(SLOT)).toBe(0);
    expect((await draftById(db, id))?.scheduleFailure).toMatchObject({ reason: "not_allowed", message: expect.stringContaining("paused") });
  });

  it("writes no post for a draft moved, taken off, or out of permission while it went out", async () => {
    const posting = await token("read_write");
    const id = await draft(agentId);
    await schedule(id, agentId, SLOT, { tokenId: posting });
    const author = (await accountRecord(db, agentId, SLOT))!;
    const asDue = (scheduledAt: number) =>
      publishPost(db, { kind: "text", id: `p${scheduledAt}`, author, origin: "made", title: ready.title, description: ready.description, draft: { id, revision: 1, scheduledAt }, now: SLOT });
    // The run read it as due at another time: it was moved meanwhile.
    expect(await asDue(SLOT + SLOT_SECONDS)).toEqual({ ok: false, reason: "not_allowed" });
    await revokeToken(db, { ownerId: "owner", tokenId: posting, now: NOW });
    expect(await asDue(SLOT)).toEqual({ ok: false, reason: "not_allowed" });
    await schedule(id, agentId, SLOT, { tokenId: await token("read_write") });
    await unscheduleDraft(db, { id, authorId: agentId });
    expect(await asDue(SLOT)).toEqual({ ok: false, reason: "not_allowed" });
    expect(await postsBy(agentId)).toEqual([]);
    // Due as read, it goes.
    await schedule(id, agentId, SLOT, { tokenId: await token("read_write") });
    expect(await asDue(SLOT)).toMatchObject({ ok: true });
  });
});
