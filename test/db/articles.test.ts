import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { ARTICLE_MEDIA_MAX } from "../../app/lib/article";
import { accountRecord } from "../../app/lib/db/accounts.server";
import { editPost } from "../../app/lib/db/authoring.server";
import { deleteAccount } from "../../app/lib/db/deletion.server";
import { deleteDraft, publishDraft, saveDraft } from "../../app/lib/db/drafts.server";
import { deleteReleasedFiles } from "../../app/lib/db/draft-files.server";
import { newPage } from "../../app/lib/db/feed.server";
import { purgePostMedia, removePost } from "../../app/lib/db/moderation.server";
import { postPage } from "../../app/lib/db/posts.server";
import { postCoverVersion } from "../../app/lib/og/version";
import { publishPost } from "../../app/lib/db/submit.server";
import type { DraftFields } from "../../app/lib/draft-rules";
import { textPreview, type TextPreview } from "../../app/lib/submit/text-preview.server";
import { storeUpload } from "../../app/lib/uploads.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const bucket = env.IMAGES;

/** A PNG's signature and header: enough to be read as a picture of its size. */
const png = (width: number, height: number) => {
  const u32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255];
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...u32(13), 0x49, 0x48, 0x44, 0x52, ...u32(width), ...u32(height), 8, 6, 0, 0, 0]);
};
const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), ...new Array(80).fill(1)]);

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Sends a file for an article, into its set. */
async function send(owner: string, bytes: Uint8Array = png(1600, 900), size: { width: number; height: number } | null = null): Promise<string> {
  const result = await storeUpload(db, bucket, { ownerId: owner, body: stream(bytes), length: bytes.length, role: "media", set: "article-set-1", size, now: NOW });
  if (!result.ok) throw new Error(result.reason);
  return result.key;
}

const place = (key: string, words = "What it shows") => `![${words}](upload:${key})`;
const stateOf = async (key: string) =>
  (await db.prepare(`SELECT state FROM images WHERE key = ?1`).bind(key).first<{ state: string }>())?.state ?? null;

async function article(owner: string, description: string, id = "article") {
  const author = (await accountRecord(db, owner, NOW))!;
  return publishPost(db, { kind: "text", id, author, origin: "made", title: "How the rain was made", description, now: NOW });
}

beforeEach(async () => {
  await reset();
  const stored = (await bucket.list()).objects.map((object) => object.key);
  if (stored.length > 0) await bucket.delete(stored);
  await db.prepare(`DELETE FROM file_deletions`).run();
  await user("u1", "quiet_otter", { plan: true });
  await user("u2", "paper_lark", { plan: true });
});

describe("an article's uploads", () => {
  it("are claimed with it, in the order its text shows them, with their sizes, and shown on its page alone", async () => {
    const picture = await send("u1");
    const video = await send("u1", MP4, { width: 1080, height: 1920 });
    const text = `It began with a still.\n\n${place(picture)}\n\nThen it moved:\n\n${place(video, "The street, raining")}\n\n${place(picture, "Once more")}`;
    expect(await article("u1", text)).toEqual({ ok: true, id: "article", freed: [] });
    expect(await stateOf(picture)).toBe("attached");
    expect(await stateOf(video)).toBe("attached");
    const page = await postPage(db, "article");
    const post = page?.state === "live" ? page.post : null;
    expect(post?.files).toEqual([
      { key: picture, type: "image", width: 1600, height: 900, src: expect.stringContaining(picture) },
      { key: video, type: "video", width: 1080, height: 1920, src: expect.stringContaining(video) },
    ]);
    expect(post?.excerpt).toBe("It began with a still.\nThen it moved:");
    // A listing carries the excerpt alone.
    const [card] = (await newPage(db, "all", NOW, null)).posts;
    expect(card).not.toHaveProperty("files");
    expect(card).not.toHaveProperty("description");
    // Only how many, so the card offers Show more.
    expect(card?.uploads).toBe(2);
  });

  it("go in all together or not at all: another's, another post's, one gone, too many, or one not on its own line refuses it", async () => {
    const mine = await send("u1");
    const theirs = await send("u2");
    const refused = async (text: string) => {
      const result = await article("u1", `Some words first.\n\n${text}`);
      expect(result).toMatchObject({ ok: false, reason: "media" });
      expect(await stateOf(mine)).toBe("pending");
      return result.ok ? "" : result.reason === "media" ? result.problem : "";
    };
    expect(await refused(`${place(mine)}\n\n${place(theirs)}`)).toContain(theirs);
    expect(await refused(place(`${"z".repeat(24)}.png`))).toContain("not an upload");
    expect(await refused(`In a sentence ${place(mine)} it shows as words.`)).toContain("line of its own");
    const many = Array.from({ length: ARTICLE_MEDIA_MAX + 1 }, (_, n) => place(`${String(n).padStart(24, "b")}.png`)).join("\n\n");
    expect(await refused(many)).toContain(`at most ${ARTICLE_MEDIA_MAX}`);
    // One already another post's.
    expect(await article("u1", `First.\n\n${place(mine)}`, "first")).toMatchObject({ ok: true });
    expect(await article("u1", `Second.\n\n${place(mine)}`, "second")).toMatchObject({ ok: false, reason: "media" });
    // Only a text post places uploads.
    const author = (await accountRecord(db, "u1", NOW))!;
    const other = await send("u1");
    const link = await publishPost(db, {
      kind: "link", id: "link", author, origin: "found", title: "A link", description: `About it.\n\n${place(other)}`,
      url: "https://example.com/a", canonicalKey: "example.com/a", provider: null, aspect: null, pageTitle: null, thumbKey: null, now: NOW,
    });
    expect(link).toMatchObject({ ok: false, reason: "media", problem: "Only a text post places uploads in its text." });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM posts`).first()).toEqual({ n: 1 });
  });

  it("change with an edit: one placed anew is claimed, one dropped is deleted at once, and a refused edit changes nothing", async () => {
    const first = await send("u1");
    const second = await send("u1");
    await article("u1", `Before.\n\n${place(first)}\n\n${place(second)}`);
    const edit = { id: "article", authorId: "u1", title: "How the rain was made", origin: "made" as const, now: NOW + 60 };
    const third = await send("u1", png(640, 480));
    const result = await editPost(db, { ...edit, description: `Before.\n\n${place(third)}\n\n${place(first)}` });
    expect(result).toEqual({ ok: true, freed: [second] });
    expect(await stateOf(third)).toBe("attached");
    expect(await stateOf(second)).toBeNull();
    expect(await db.prepare(`SELECT key FROM file_deletions`).all()).toMatchObject({ results: [{ key: second }] });
    await deleteReleasedFiles(db, bucket, result.ok ? result.freed : []);
    expect(await bucket.get(second)).toBeNull();
    const page = await postPage(db, "article");
    expect(page?.state === "live" ? page.post.files?.map((file) => [file.key, file.width]) : null).toEqual([
      [third, 640],
      [first, 1600],
    ]);
    // Another's upload refuses the edit, and nothing it held goes.
    const theirs = await send("u2");
    expect(await editPost(db, { ...edit, description: `After.\n\n${place(theirs)}` })).toMatchObject({ ok: false, reason: "media" });
    expect(await stateOf(first)).toBe("attached");
    expect(await stateOf(third)).toBe("attached");
    // Nor does an edit that cannot land, after the title's hour.
    expect(await editPost(db, { ...edit, title: "Another title", description: "After, with none.", now: NOW + DAY })).toEqual({
      ok: false,
      reason: "window",
    });
    expect(await stateOf(first)).toBe("attached");
  });

  it("stay, unshown, when its author deletes it, and go with the account; a takedown purges them", async () => {
    const kept = await send("u1");
    await article("u1", `Words.\n\n${place(kept)}`);
    await db.prepare(`UPDATE posts SET deleted_at = ?1 WHERE id = 'article'`).bind(NOW + DAY).run();
    expect(await stateOf(kept)).toBe("attached");
    const files = await deleteAccount(db, { userId: "u1", content: false, banned: false, identities: [], now: NOW + 2 * DAY });
    expect(files).toContain(kept);
    expect(await stateOf(kept)).toBeNull();
    expect(await db.prepare(`SELECT inline_media FROM posts WHERE id = 'article'`).first()).toEqual({ inline_media: null });

    const taken = await send("u2");
    await article("u2", `Words.\n\n${place(taken)}`, "theirs");
    await user("mod", "a_moderator", { role: "admin" });
    await removePost(db, { postId: "theirs", actorId: "mod", reason: "spam", now: NOW });
    expect(await purgePostMedia(db, bucket, { postId: "theirs", actorId: "mod", now: NOW })).toEqual([taken]);
    expect(await stateOf(taken)).toBeNull();
  });
});

describe("an article's uploads in a draft", () => {
  const fields = (description: string): DraftFields => ({
    kind: "text",
    url: null,
    origin: "made",
    title: "How the rain was made",
    description,
    replies: null,
    mediaKey: null,
    width: null,
    height: null,
    duration: null,
    posterKey: null,
    pictures: null,
  });

  it("are kept as its own, let go when its text drops them, and published with it", async () => {
    const first = await send("u1");
    const second = await send("u1");
    const saved = await saveDraft(db, { authorId: "u1", fields: fields(`${place(first)}\n\n${place(second)}`), now: NOW });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    expect(saved.draft.inlineMedia.map((file) => file.key)).toEqual([first, second]);
    expect(await stateOf(first)).toBe("draft");
    // Another upload, in another set, leaves them alone.
    await storeUpload(db, bucket, { ownerId: "u1", body: stream(png(10, 10)), length: png(10, 10).length, role: "media", set: "another-set", now: NOW });
    expect(await stateOf(second)).toBe("draft");
    const changed = await saveDraft(db, { authorId: "u1", id: saved.draft.id, revision: 1, fields: fields(`Only one now.\n\n${place(first)}`), now: NOW });
    expect(changed).toMatchObject({ ok: true, freed: [second] });
    expect(await stateOf(second)).toBeNull();
    // A stray placement is refused, and the draft stays as it was.
    expect(await saveDraft(db, { authorId: "u1", id: saved.draft.id, revision: 2, fields: fields(`See ${place(first)} here.`), now: NOW })).toMatchObject({
      ok: false,
      reason: "invalid",
      fields: { description: expect.stringContaining("line of its own") },
    });
    const published = await publishDraft(db, {
      id: saved.draft.id, actorId: "u1", as: "author", revision: 2, bucket, secret: env.BETTER_AUTH_SECRET, ownHosts: ["aion.ly"], mentionHosts: ["aion.ly"], now: NOW,
    });
    if (!published.ok) throw new Error(JSON.stringify(published));
    expect(await stateOf(first)).toBe("attached");
    const page = await postPage(db, published.postId);
    expect(page?.state === "live" ? page.post.files?.map((file) => file.key) : null).toEqual([first]);
  });

  it("go with the draft when it is deleted, and count toward the drafts' size", async () => {
    const kept = await send("u1");
    const saved = await saveDraft(db, { authorId: "u1", fields: fields(place(kept)), now: NOW });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    const bytes = await db.prepare(`SELECT bytes FROM images WHERE key = ?1`).bind(kept).first<{ bytes: number }>();
    expect(bytes?.bytes).toBeGreaterThan(0);
    expect(await deleteDraft(db, { id: saved.draft.id, authorId: "u1" })).toEqual({ ok: true, freed: [kept] });
    expect(await stateOf(kept)).toBeNull();
  });
});

describe("a text post's card preview", () => {
  const preview = (text: string, current?: { json: string | null; thumbKey: string | null }, shown = true) =>
    textPreview({ text, shown, current, userId: "u1", ownHosts: ["aion.ly"], db, bucket, now: NOW });

  /** A link's picture, kept as the account's pending snapshot, as a link check keeps one. */
  async function snapshot(owner = "u1") {
    const bytes = png(1200, 630);
    const result = await storeUpload(db, bucket, { ownerId: owner, body: stream(bytes), length: bytes.length, role: "poster", now: NOW });
    if (!result.ok) throw new Error(result.reason);
    return result.key;
  }

  async function textPost(description: string, given: TextPreview, id = "article", owner = "u1") {
    const author = (await accountRecord(db, owner, NOW))!;
    return publishPost(db, { kind: "text", id, author, origin: "made", title: "How the rain was made", description, preview: given, now: NOW });
  }

  it("is the first of its uploads and links, passing over the board's own, or none when its author chose so", async () => {
    const still = await send("u1");
    const text = `See https://aion.ly/p/another first.\n\n${place(still, "The still")}\n\nThen https://example.com/page.`;
    expect(await preview(text)).toEqual({ shown: true, json: JSON.stringify({ upload: still, alt: "The still" }), thumbKey: null });
    expect(await preview(text, undefined, false)).toEqual({ shown: false, json: null, thumbKey: null });
    expect(await preview("Only words, and http://example.com/plain.")).toEqual({ shown: true, json: null, thumbKey: null });
    // A link it shows already keeps its title and picture, read no more.
    const held = { json: JSON.stringify({ link: "https://example.com/page", provider: null, aspect: null, title: "The page" }), thumbKey: "kept.png" };
    expect(await preview("Read https://example.com/page now.", held)).toEqual({ shown: true, json: held.json, thumbKey: "kept.png" });
  });

  it("shows its upload or link on its card, the link's picture its own, and not on its page for an upload", async () => {
    const still = await send("u1");
    await textPost(`Words.\n\n${place(still, "The still")}`, await preview(`Words.\n\n${place(still, "The still")}`));
    const [card] = (await newPage(db, "all", NOW, null)).posts;
    expect(card?.preview).toEqual({ media: { kind: "image", src: expect.stringContaining(still), width: 1600, height: 900 }, upload: still, alt: "The still" });
    expect(card?.uploads).toBe(1);

    // Another author's, as one may post once a day.
    const picture = await snapshot("u2");
    const link = { shown: true, json: JSON.stringify({ link: "https://example.com/page", provider: null, aspect: null, title: "The page" }), thumbKey: picture };
    expect(await textPost("Read https://example.com/page now.", link, "linked", "u2")).toMatchObject({ ok: true });
    expect(await stateOf(picture)).toBe("attached");
    const page = await postPage(db, "linked");
    expect(page?.state === "live" ? page.post.preview : null).toEqual({
      media: { kind: "page", pageTitle: "The page", thumbUrl: expect.stringContaining(picture) },
      url: "https://example.com/page",
      host: "example.com",
    });
    expect(page?.state === "live" ? page.post.showPreview : null).toBe(true);
  });

  it("leaves the links its text shows as players to Show more, all but the one it previews, and out of its excerpt", async () => {
    const text = [
      "Three to watch.",
      "https://youtu.be/dQw4w9WgXcQ",
      "Then a post:",
      "https://x.com/someone/status/1850000000000000001",
      "",
      "> https://t.me/durov/123",
      "",
      "And https://www.youtube.com/watch?v=aaaaaaaaaaa in a sentence.",
    ].join("\n");
    const video = { shown: true, json: JSON.stringify({ link: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", provider: "youtube", aspect: "16:9", title: null }), thumbKey: null };
    await textPost(text, video);
    const [card] = (await newPage(db, "all", NOW, null)).posts;
    expect(card?.embeds).toBe(2);
    expect(card?.excerpt).toBe("Three to watch.\nThen a post:\nAnd https://www.youtube.com/watch?v=aaaaaaaaaaa in a sentence.");
    // Without a preview, every one of them is left to Show more.
    await textPost(text, { shown: false, json: null, thumbKey: null }, "unpreviewed", "u2");
    expect((await newPage(db, "all", NOW, null)).posts.find((post) => post.id === "unpreviewed")?.embeds).toBe(3);
  });

  it("changes with an edit: hidden without an edited mark, and a picture it no longer shows is deleted", async () => {
    const first = await snapshot();
    const link = (url: string, thumbKey: string | null) => ({ shown: true, json: JSON.stringify({ link: url, provider: null, aspect: null, title: null }), thumbKey });
    await textPost("Read https://example.com/one now.", link("https://example.com/one", first));
    const edit = { id: "article", authorId: "u1", title: "How the rain was made", origin: "made" as const, description: "Read https://example.com/one now.", now: NOW + DAY };
    const hidden = await editPost(db, { ...edit, preview: { shown: false, json: null, thumbKey: null } });
    expect(hidden).toEqual({ ok: true, freed: [first] });
    expect(await stateOf(first)).toBeNull();
    expect(await db.prepare(`SELECT card_preview, card_preview_shown, thumb_key, edited_at FROM posts WHERE id = 'article'`).first()).toEqual({
      card_preview: null,
      card_preview_shown: 0,
      thumb_key: null,
      edited_at: null,
    });
    // Shown again, with another link's picture.
    const second = await snapshot();
    const shown = await editPost(db, { ...edit, description: "Read https://example.com/two now.", preview: link("https://example.com/two", second) });
    expect(shown).toEqual({ ok: true, freed: [] });
    expect(await stateOf(second)).toBe("attached");
    // The same edit again changes nothing.
    expect(await editPost(db, { ...edit, description: "Read https://example.com/two now.", preview: link("https://example.com/two", second) })).toEqual({
      ok: true,
      freed: [],
    });
    const third = await snapshot();
    expect(await editPost(db, { ...edit, description: "Read https://example.com/three now.", preview: link("https://example.com/three", third) })).toEqual({
      ok: true,
      freed: [second],
    });
  });
});

describe("an article's share cover", () => {
  it("changes its version with its picture when only the preview changes (review F130)", async () => {
    const bytes = png(1200, 630);
    const stored = await storeUpload(db, bucket, { ownerId: "u1", body: stream(bytes), length: bytes.length, role: "poster", now: NOW });
    if (!stored.ok) throw new Error(stored.reason);
    const still = await send("u1");
    const description = `Read https://example.com/page first.\n\n${place(still)}`;
    const linkPreview = { shown: true, json: JSON.stringify({ link: "https://example.com/page", provider: null, aspect: null, title: null }), thumbKey: stored.key };
    const author = (await accountRecord(db, "u1", NOW))!;
    await publishPost(db, { kind: "text", id: "article", author, origin: "made", title: "A cover that changes", description, preview: linkPreview, now: NOW });
    const version = async () => {
      const page = await postPage(db, "article");
      const post = page?.state === "live" ? page.post : null;
      return {
        picture: post?.coverPicture?.key ?? null,
        version: postCoverVersion({ title: post!.title, description: post!.description, author: post!.author.username, agent: false, origin: post!.origin, picture: post?.coverPicture?.key ?? null }),
      };
    };
    const before = await version();
    expect(before.picture).toBe(stored.key);
    // Hidden, the cover falls back to the first picture the text places, under a new version.
    const edit = { id: "article", authorId: "u1", title: "A cover that changes", origin: "made" as const, description, now: NOW + 60 };
    expect(await editPost(db, { ...edit, preview: { shown: false, json: null, thumbKey: null } })).toMatchObject({ ok: true });
    const after = await version();
    expect(after.picture).toBe(still);
    expect(after.version).not.toBe(before.version);
  });
});
