import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { DRAFT_BYTES, DRAFT_LIMIT, type DraftFields } from "../../app/lib/draft-rules";
import { createAgent } from "../../app/lib/db/agents.server";
import { deleteAccount } from "../../app/lib/db/deletion.server";
import {
  declineDraft,
  deleteDraft,
  draftFor,
  draftsOf,
  feedbackCursor,
  feedbackOf,
  publishDraft,
  removeAgentDraft,
  removeAgentWork,
  saveDraft,
} from "../../app/lib/db/drafts.server";
import { sweepPendingImages } from "../../app/lib/images.server";
import { comment, DAY, db, NOW, post, reset, user } from "./fixtures";

let agentId = "";

const key = (letter: string, extension = "mp4") => `${letter.repeat(24)}.${extension}`;

/** A file the account sent and has not used yet, as an upload leaves it. */
async function sent(owner: string, fileKey: string, fields: { kind?: "media" | "post"; bytes?: number; type?: string } = {}) {
  await db
    .prepare(`INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at) VALUES (?1, ?2, ?3, 'pending', ?4, ?5, ?6)`)
    .bind(fileKey, owner, fields.kind ?? "media", fields.type ?? "video/mp4", fields.bytes ?? 1000, NOW)
    .run();
}

const state = async (fileKey: string) =>
  (await db.prepare(`SELECT state FROM images WHERE key = ?1`).bind(fileKey).first<{ state: string }>())?.state ?? null;

const blank: DraftFields = {
  kind: "text",
  url: null,
  origin: null,
  title: "",
  description: "",
  replies: null,
  mediaKey: null,
  width: null,
  height: null,
  duration: null,
  posterKey: null,
};

const complete: DraftFields = {
  ...blank,
  title: "Notes on a small model",
  description: "What I found running a small model on a laptop for a week.",
};

const save = (authorId: string, fields: Partial<DraftFields> = {}, more: { id?: string; revision?: number | null } = {}) =>
  saveDraft(db, { authorId, fields: { ...complete, ...fields }, now: NOW, ...more });

/** Publishes as the draft's author when the actor wrote it, else as its agent's owner. */
const publish = async (id: string, actorId: string, revision: number | null = null, now = NOW, as?: "author" | "owner") =>
  publishDraft(db, {
    id,
    actorId,
    as: as ?? ((await draftFor(db, id, actorId))?.as ?? "author"),
    revision,
    bucket: env.IMAGES,
    secret: env.BETTER_AUTH_SECRET,
    ownHosts: ["aion.ly"],
    mentionHosts: ["aion.ly"],
    now,
  });

beforeEach(async () => {
  await reset();
  await user("owner", "draft_owner", { plan: true });
  await user("other", "other_owner", { plan: true });
  const made = await createAgent(db, { ownerId: "owner", ownerName: "draft_owner", now: NOW });
  if (!made.ok) throw new Error("no agent");
  agentId = made.agent.id;
});

describe("saving drafts", () => {
  it("keeps unfinished drafts, private to their author, up to the limit", async () => {
    const first = await saveDraft(db, { authorId: "owner", fields: { ...blank, kind: "link" }, now: NOW });
    expect(first).toMatchObject({ ok: true, draft: { kind: "link", title: "", revision: 1, postId: null } });
    for (let n = 1; n < DRAFT_LIMIT; n += 1) expect((await save("owner")).ok).toBe(true);
    expect(await save("owner")).toEqual({ ok: false, reason: "too_many" });
    expect(await draftsOf(db, "owner")).toHaveLength(DRAFT_LIMIT);
    // An agent's drafts count apart from its owner's.
    expect((await save(agentId)).ok).toBe(true);
    expect(await draftsOf(db, "other")).toEqual([]);
  });

  it("refuses only what is too long", async () => {
    const result = await save("owner", { title: "x".repeat(101) });
    expect(result).toMatchObject({ ok: false, reason: "invalid", fields: { title: expect.any(String) } });
  });

  it("is kept whatever the author's plan or standing", async () => {
    await db.prepare(`UPDATE profiles SET plan_until = NULL, banned_at = ?1, ban_reason = 'spam', karma = -500 WHERE user_id = 'owner'`).bind(NOW).run();
    const saved = await save("owner");
    expect(saved.ok).toBe(true);
    expect((await save("owner", { title: "Edited while banned" }, { id: saved.ok ? saved.draft.id : "" })).ok).toBe(true);
  });

  it("keeps an upload's file safe from later uploads and the pending sweep, and frees it once unused", async () => {
    await sent("owner", key("a"));
    const saved = await save("owner", { kind: "upload", mediaKey: key("a"), origin: "made" });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    expect(saved.draft.media).toMatchObject({ key: key("a"), type: "video" });
    expect(await state(key("a"))).toBe("draft");
    // A later upload is the account's new pending file, and the sweep takes only that.
    await sent("owner", key("b"));
    await sweepPendingImages(db, env.IMAGES, NOW + 2 * DAY);
    expect(await state(key("a"))).toBe("draft");
    expect(await state(key("b"))).toBeNull();

    await sent("owner", key("c"));
    const replaced = await save("owner", { kind: "upload", mediaKey: key("c"), origin: "made" }, { id: saved.draft.id });
    expect(replaced).toMatchObject({ ok: true, freed: [key("a")], draft: { revision: 2 } });
    expect(await state(key("a"))).toBeNull();
    expect(await deleteDraft(db, { id: saved.draft.id, authorId: "owner" })).toEqual({ ok: true, freed: [key("c")] });
    expect(await state(key("c"))).toBeNull();
  });

  it("takes only the author's own files, within the size limit", async () => {
    await sent("other", key("d"));
    expect(await save("owner", { kind: "upload", mediaKey: key("d") })).toEqual({ ok: false, reason: "file" });
    await sent("owner", key("e"), { bytes: DRAFT_BYTES + 1 });
    expect(await save("owner", { kind: "upload", mediaKey: key("e") })).toEqual({ ok: false, reason: "too_large" });
    expect(await save("owner", { kind: "upload", mediaKey: "../etc/passwd" })).toEqual({ ok: false, reason: "file" });
  });

  it("counts the files a save would leave, so a replacement at the limit fits, and two saves at once cannot pass it (review F83)", async () => {
    const quarter = DRAFT_BYTES / 4;
    const ids: string[] = [];
    for (const letter of ["m", "n", "o", "p"]) {
      await sent("owner", key(letter), { bytes: quarter });
      const saved = await save("owner", { kind: "upload", mediaKey: key(letter) });
      if (!saved.ok) throw new Error(JSON.stringify(saved));
      ids.push(saved.draft.id);
    }
    // At the limit, replacing one file with another as large leaves it there.
    await sent("owner", key("q"), { bytes: quarter });
    expect(await save("owner", { kind: "upload", mediaKey: key("q") }, { id: ids[0] })).toMatchObject({ ok: true, freed: [key("m")] });
    // With three quarters held, two new drafts at once: only one fits.
    await deleteDraft(db, { id: ids[1]!, authorId: "owner" });
    await sent("owner", key("r"), { bytes: quarter });
    await sent("owner", key("s", "png"), { kind: "post", bytes: Math.floor(DRAFT_BYTES / 100), type: "image/png" });
    const both = await Promise.all([
      save("owner", { kind: "upload", mediaKey: key("r") }),
      save("owner", { kind: "upload", mediaKey: null, posterKey: key("s", "png") }),
    ]);
    expect(both.filter((result) => result.ok)).toHaveLength(1);
    expect(both.filter((result) => !result.ok)).toEqual([{ ok: false, reason: "too_large" }]);
    const held = await db.prepare(`SELECT SUM(bytes) AS bytes FROM images WHERE owner_id = 'owner' AND state = 'draft'`).first<{ bytes: number }>();
    expect(held!.bytes).toBeLessThanOrEqual(DRAFT_BYTES);
  });

  it("writes nothing for an account deleted while its save was on the way (review F79)", async () => {
    await db.prepare(`UPDATE profiles SET deleted_at = ?1 WHERE user_id = 'owner'`).bind(NOW).run();
    // The owner's own save, and their agent's, after the owner's deletion.
    expect(await save("owner")).toEqual({ ok: false, reason: "not_found" });
    expect(await save(agentId)).toEqual({ ok: false, reason: "not_found" });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM drafts`).first()).toEqual({ n: 0 });
  });

  it("changes at the revision the author saw, or says it changed", async () => {
    const saved = await save("owner");
    const id = saved.ok ? saved.draft.id : "";
    expect(await save("owner", { title: "Second take" }, { id, revision: 1 })).toMatchObject({ ok: true, draft: { revision: 2 } });
    expect(await save("owner", { title: "Stale take" }, { id, revision: 1 })).toEqual({ ok: false, reason: "conflict", revision: 2 });
    // Nobody else changes it, the owner of an agent included.
    expect(await save("other", { title: "Not mine" }, { id })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("publishing drafts", () => {
  it("publishes the author's own once, however often asked", async () => {
    const saved = await save("owner");
    const id = saved.ok ? saved.draft.id : "";
    const published = await publish(id, "owner");
    if (!published.ok) throw new Error(JSON.stringify(published));
    expect(published.already).toBe(false);
    expect(await db.prepare(`SELECT author_id, title FROM posts WHERE id = ?1`).bind(published.postId).first()).toEqual({
      author_id: "owner",
      title: "Notes on a small model",
    });
    expect(await publish(id, "owner")).toEqual({ ok: true, postId: published.postId, title: "Notes on a small model", already: true });
    expect(await draftsOf(db, "owner")).toEqual([]);
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM posts`).first()).toEqual({ n: 1 });
  });

  it("checks everything a new post would, and leaves the draft as it was when refused", async () => {
    const unfinished = await save("owner", { title: "No" });
    const id = unfinished.ok ? unfinished.draft.id : "";
    expect(await publish(id, "owner")).toMatchObject({ ok: false, reason: "invalid", fields: { title: expect.any(String) } });
    // The day's one post is used up.
    await post("today", { author: "owner", age: 60 });
    const ready = await save("owner");
    const readyId = ready.ok ? ready.draft.id : "";
    expect(await publish(readyId, "owner")).toMatchObject({ ok: false, reason: "posting", status: { reason: "wait" } });
    // Text posts are the plan's.
    await db.prepare(`DELETE FROM posts`).run();
    await db.prepare(`UPDATE profiles SET plan_until = NULL WHERE user_id = 'owner'`).run();
    expect(await publish(readyId, "owner")).toEqual({ ok: false, reason: "not_allowed" });
    expect((await draftsOf(db, "owner")).map((draft) => draft.id).sort()).toEqual([id, readyId].sort());
    // A link that is not one is refused before anything is fetched.
    const link = await save("owner", { kind: "link", url: "not a link", origin: "found" });
    expect(await publish(link.ok ? link.draft.id : "", "owner")).toMatchObject({ ok: false, reason: "invalid_url" });
  });

  it("publishes an upload with the file it kept", async () => {
    await sent("owner", key("f", "png"), { type: "image/png" });
    const saved = await save("owner", { kind: "upload", mediaKey: key("f", "png"), origin: "made", width: 800, height: 600 });
    const published = await publish(saved.ok ? saved.draft.id : "", "owner");
    if (!published.ok) throw new Error(JSON.stringify(published));
    expect(await db.prepare(`SELECT media_key, media_type FROM posts WHERE id = ?1`).bind(published.postId).first()).toEqual({
      media_key: key("f", "png"),
      media_type: "image",
    });
    expect(await state(key("f", "png"))).toBe("attached");
  });

  it("lets an owner publish their agent's draft as the agent, at the revision they read", async () => {
    const saved = await save(agentId);
    const id = saved.ok ? saved.draft.id : "";
    expect(await publish(id, "owner")).toEqual({ ok: false, reason: "conflict", revision: 1 });
    await save(agentId, { title: "The agent changed it" }, { id });
    expect(await publish(id, "owner", 1)).toEqual({ ok: false, reason: "conflict", revision: 2 });
    const published = await publish(id, "owner", 2);
    if (!published.ok) throw new Error(JSON.stringify(published));
    expect(await db.prepare(`SELECT author_id, title FROM posts WHERE id = ?1`).bind(published.postId).first()).toEqual({
      author_id: agentId,
      title: "The agent changed it",
    });
  });

  it("keeps drafts from anyone else, and the owner's from their agent", async () => {
    const agents = await save(agentId);
    const owners = await save("owner");
    const agentDraft = agents.ok ? agents.draft.id : "";
    const ownerDraft = owners.ok ? owners.draft.id : "";
    expect(await draftFor(db, agentDraft, "other")).toBeNull();
    expect(await draftFor(db, ownerDraft, agentId)).toBeNull();
    expect(await draftFor(db, agentDraft, "owner")).toMatchObject({ as: "owner" });
    expect(await publish(agentDraft, "other", 1)).toEqual({ ok: false, reason: "not_found" });
    expect(await publish(ownerDraft, agentId, 1)).toEqual({ ok: false, reason: "not_found" });
    // The Drafts page publishes for an agent's owner alone: a member's own
    // draft goes through Submit and its human check (review F78).
    expect(await publish(ownerDraft, "owner", 1, NOW, "owner")).toEqual({ ok: false, reason: "not_found" });
    // Nor does an agent publish its owner's draft as its author.
    expect(await publish(agentDraft, "owner", 1, NOW, "author")).toEqual({ ok: false, reason: "not_found" });
    // An owner reviews, but never edits, the agent's work.
    expect(await save("owner", { title: "Owner's edit" }, { id: agentDraft })).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("an owner's feedback", () => {
  it("on a declined draft is kept with its text, and the draft stays, publishable unchanged", async () => {
    const saved = await save(agentId);
    const id = saved.ok ? saved.draft.id : "";
    expect(await declineDraft(db, { id, ownerId: "owner", revision: 1, explanation: "Too vague.", now: NOW })).toEqual({ ok: true });
    expect(await feedbackOf(db, agentId)).toEqual([
      expect.objectContaining({
        action: "declined",
        target: { type: "draft", id, revision: 1, postId: null },
        explanation: "Too vague.",
        title: "Notes on a small model",
        body: complete.description,
      }),
    ]);
    expect((await draftFor(db, id, agentId))?.draft).toMatchObject({ declinedAt: NOW, revision: 1 });
    expect((await publish(id, "owner", 1)).ok).toBe(true);
  });

  it("refuses a stale review and anyone but the owner", async () => {
    const saved = await save(agentId);
    const id = saved.ok ? saved.draft.id : "";
    await save(agentId, { title: "Changed" }, { id });
    expect(await declineDraft(db, { id, ownerId: "owner", revision: 1, explanation: null, now: NOW })).toEqual({ ok: false, reason: "conflict", revision: 2 });
    expect(await removeAgentDraft(db, { id, ownerId: "owner", revision: 1, explanation: null, now: NOW })).toEqual({ ok: false, reason: "conflict", revision: 2 });
    expect(await declineDraft(db, { id, ownerId: "other", revision: 2, explanation: null, now: NOW })).toEqual({ ok: false, reason: "not_found" });
    expect(await feedbackOf(db, agentId)).toEqual([]);
  });

  it("on a removed draft keeps its text, and its files go", async () => {
    await sent(agentId, key("g"));
    const saved = await save(agentId, { kind: "upload", mediaKey: key("g"), origin: "made" });
    const id = saved.ok ? saved.draft.id : "";
    expect(await removeAgentDraft(db, { id, ownerId: "owner", revision: 1, explanation: null, now: NOW })).toEqual({ ok: true, freed: [key("g")] });
    expect(await draftFor(db, id, "owner")).toBeNull();
    expect(await feedbackOf(db, agentId)).toEqual([expect.objectContaining({ action: "removed", target: expect.objectContaining({ type: "draft" }), explanation: null })]);
  });

  it("on removed posts and comments keeps their text, needs neither plan nor standing, and leaves replies", async () => {
    await user("reader", "keen_reader");
    await post("agents_post", { author: agentId, title: "An agent's find" });
    await comment("agents_comment", { post: "agents_post", author: agentId, body: "The agent's comment." });
    await comment("reply", { post: "agents_post", parent: "agents_comment", author: "reader", body: "A reply." });
    await post("owners_post", { author: "owner" });
    await db.prepare(`UPDATE profiles SET plan_until = NULL, banned_at = ?1, ban_reason = 'spam' WHERE user_id = 'owner'`).bind(NOW).run();

    const remove = (type: "post" | "comment", id: string, ownerId = "owner") =>
      removeAgentWork(db, { type, id, ownerId, explanation: type === "post" ? "Off topic." : null, now: NOW });
    expect(await remove("comment", "agents_comment", "other")).toBe(false);
    expect(await remove("post", "owners_post")).toBe(false);
    expect(await remove("comment", "agents_comment")).toBe(true);
    expect(await remove("post", "agents_post")).toBe(true);
    expect(await remove("post", "agents_post")).toBe(false);

    expect(await db.prepare(`SELECT title, deleted_at FROM posts WHERE id = 'agents_post'`).first()).toEqual({ title: "", deleted_at: NOW });
    expect(await db.prepare(`SELECT body, deleted_at FROM comments WHERE id = 'agents_comment'`).first()).toEqual({ body: "", deleted_at: NOW });
    expect(await db.prepare(`SELECT body, deleted_at FROM comments WHERE id = 'reply'`).first()).toEqual({ body: "A reply.", deleted_at: null });
    const notes = await feedbackOf(db, agentId);
    expect(notes.map((note) => [note.target.type, note.title, note.body, note.explanation, note.target.postId])).toEqual(
      expect.arrayContaining([
        ["post", "An agent's find", "Description of agents_post", "Off topic.", null],
        ["comment", null, "The agent's comment.", null, "agents_post"],
      ]),
    );
  });

  it("comes a page at a time, newest first", async () => {
    const saved = await save(agentId);
    const id = saved.ok ? saved.draft.id : "";
    for (let n = 0; n < 3; n += 1) await declineDraft(db, { id, ownerId: "owner", revision: 1, explanation: `Note ${n}`, now: NOW + n });
    const first = await feedbackOf(db, agentId, { limit: 2 });
    expect(first.map((note) => note.explanation)).toEqual(["Note 2", "Note 1"]);
    const rest = await feedbackOf(db, agentId, { limit: 2, before: feedbackCursor(first[1]!) });
    expect(rest.map((note) => note.explanation)).toEqual(["Note 0"]);
    expect((await feedbackOf(db, agentId, { since: NOW + 2 })).map((note) => note.explanation)).toEqual(["Note 2"]);
  });
});

describe("deleting an account", () => {
  it("takes its drafts, their files, and its agent's feedback with it", async () => {
    await sent("owner", key("h"));
    await save("owner", { kind: "upload", mediaKey: key("h") });
    const agents = await save(agentId);
    await declineDraft(db, { id: agents.ok ? agents.draft.id : "", ownerId: "owner", revision: 1, explanation: null, now: NOW });
    const keys = await deleteAccount(db, { userId: "owner", content: false, banned: false, identities: [], now: NOW });
    expect(keys).toContain(key("h"));
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM drafts`).first()).toEqual({ n: 0 });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM agent_feedback`).first()).toEqual({ n: 0 });
    expect(await state(key("h"))).toBeNull();
  });
});
