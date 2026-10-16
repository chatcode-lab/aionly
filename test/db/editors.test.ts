import { beforeEach, describe, expect, it } from "vitest";

import {
  currentEditor,
  editorPick,
  editorTerms,
  endTerm,
  forgetEditor,
  nameEditor,
  pickPost,
  setFocus,
  termsOf,
  unpickPost,
} from "../../app/lib/db/editors.server";
import { postsByIds } from "../../app/lib/db/feed.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

const term = (username: string, from: number, days = 7) =>
  nameEditor(db, { username, startsAt: from, endsAt: from + days * DAY, actorId: "boss", now: NOW });

describe("guest editors", () => {
  beforeEach(async () => {
    await reset();
    forgetEditor();
    await user("boss", "head_admin", { role: "admin" });
    await user("ed", "guest_editor");
    await user("next", "next_editor");
    await user("u1", "writer");
    await post("p1");
    await post("p2");
    await post("p3", { removed: true });
  });

  it("are named for terms that never overlap, one editor at a time", async () => {
    expect(await term("guest_editor", NOW - DAY)).toEqual({ ok: true });
    expect(await term("next_editor", NOW + 3 * DAY)).toEqual({ ok: false, reason: "overlaps" });
    expect(await term("next_editor", NOW + 6 * DAY)).toEqual({ ok: true });
    expect(await term("nobody_here", NOW + 30 * DAY)).toEqual({ ok: false, reason: "no_member" });
    expect((await currentEditor(db, NOW))?.username).toBe("guest_editor");
    expect((await editorTerms(db)).map((entry) => entry.username)).toEqual(["next_editor", "guest_editor"]);
    expect(await termsOf(db, "ed", NOW)).toEqual([{ startsAt: NOW - DAY, endsAt: NOW + 6 * DAY }]);
  });

  it("pick live posts while the term runs, the latest pinned with its note, every pick marked", async () => {
    await term("guest_editor", NOW - DAY);
    expect(await pickPost(db, { editorId: "next", postId: "p1", note: null, now: NOW })).toEqual({ ok: false, reason: "not_editor" });
    expect(await pickPost(db, { editorId: "ed", postId: "p3", note: null, now: NOW })).toEqual({ ok: false, reason: "not_found" });
    expect(await pickPost(db, { editorId: "ed", postId: "p1", note: "Start here", now: NOW })).toEqual({ ok: true });
    expect(await pickPost(db, { editorId: "ed", postId: "p2", note: "Then this", now: NOW + 60 })).toEqual({ ok: true });
    expect(await editorPick(db, NOW + 120)).toMatchObject({ post: { id: "p2", editorsPick: true }, note: "Then this" });
    expect((await postsByIds(db, ["p1", "p2"])).map((card) => [card.id, card.editorsPick])).toEqual([
      ["p1", true],
      ["p2", true],
    ]);

    // Taking back the pinned pick pins the one before it.
    expect(await unpickPost(db, { editorId: "ed", postId: "p2", now: NOW + 180 })).toEqual({ ok: true });
    expect(await editorPick(db, NOW + 200)).toMatchObject({ post: { id: "p1" }, note: "Start here" });
    expect((await postsByIds(db, ["p2"]))[0]?.editorsPick).toBeUndefined();
    expect(await unpickPost(db, { editorId: "ed", postId: "p1", now: NOW + 240 })).toEqual({ ok: true });
    expect(await editorPick(db, NOW + 300)).toMatchObject({ post: null });
  });

  it("set the term's focus while it runs, and leave the feed when it ends; the marks stay", async () => {
    await term("guest_editor", NOW - DAY);
    expect(await setFocus(db, { editorId: "ed", focus: "Agents that ship", now: NOW })).toBe(true);
    await pickPost(db, { editorId: "ed", postId: "p1", note: "Look", now: NOW });
    expect(await editorPick(db, NOW)).toMatchObject({ term: { focus: "Agents that ship" }, post: { id: "p1" } });
    const [running] = await editorTerms(db);
    expect(await endTerm(db, { termId: running!.id, now: NOW + 60 })).toBe(true);
    expect(await editorPick(db, NOW + 120)).toBeNull();
    expect(await setFocus(db, { editorId: "ed", focus: "Late", now: NOW + 120 })).toBe(false);
    expect((await postsByIds(db, ["p1"]))[0]?.editorsPick).toBe(true);
    // The next editor cannot take an earlier term's pick, which keeps its mark.
    await term("next_editor", NOW + 200);
    expect(await pickPost(db, { editorId: "next", postId: "p1", note: null, now: NOW + 300 })).toEqual({ ok: false, reason: "already" });
  });

  it("stop editing while banned, and a term to come can be dropped", async () => {
    await term("guest_editor", NOW - DAY);
    await db.prepare(`UPDATE profiles SET banned_at = ?1 WHERE user_id = 'ed'`).bind(NOW).run();
    forgetEditor();
    expect(await currentEditor(db, NOW)).toBeNull();
    await term("next_editor", NOW + 30 * DAY);
    const [later] = await editorTerms(db);
    expect(await endTerm(db, { termId: later!.id, now: NOW })).toBe(true);
    expect((await editorTerms(db)).map((entry) => entry.username)).toEqual(["guest_editor"]);
  });
});
