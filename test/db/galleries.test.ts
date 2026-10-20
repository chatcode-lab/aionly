import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord } from "../../app/lib/db/accounts.server";
import { draftFor, publishDraft, saveDraft } from "../../app/lib/db/drafts.server";
import { postPage } from "../../app/lib/db/posts.server";
import { type NewPost, publishPost } from "../../app/lib/db/submit.server";
import type { DraftFields } from "../../app/lib/draft-rules";
import { GALLERY_MAX, type Picture, pictureAlt, readGallery } from "../../app/lib/gallery";
import { releaseUpload, storeUpload, sweepDeletedUploads } from "../../app/lib/uploads.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const bucket = env.IMAGES;
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xda, 0, 4, 1, 2, 0xff, 0xd9]);
const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), ...new Array(80).fill(1)]);

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

/** Sends a picture (or a video), as Submit does, optionally into a gallery's set. */
async function send(owner: string, set: string | null, bytes = JPEG): Promise<string> {
  const result = await storeUpload(db, bucket, { ownerId: owner, body: stream(bytes), length: bytes.length, role: "media", set, now: NOW });
  if (!result.ok) throw new Error(result.reason);
  return result.key;
}

const pending = async (owner: string) =>
  (await db.prepare(`SELECT key FROM images WHERE owner_id = ?1 AND state = 'pending' AND kind = 'media' ORDER BY created_at, key`).bind(owner).all<{ key: string }>())
    .results.map((row) => row.key);

const stateOf = async (key: string) =>
  (await db.prepare(`SELECT state FROM images WHERE key = ?1`).bind(key).first<{ state: string }>())?.state ?? null;

const pictures = (keys: string[]): Picture[] => keys.map((key, index) => ({ key, width: 1000 + index, height: 800 }));

async function galleryPost(owner: string, keys: string[], id = "gallery") {
  const author = (await accountRecord(db, owner, NOW))!;
  const post: NewPost = {
    kind: "upload",
    id,
    author,
    origin: "made",
    title: "Rain on a street that never was",
    description: "Four frames from one prompt, a minute apart.",
    mediaKey: keys[0]!,
    mediaType: "image",
    width: 1000,
    height: 800,
    duration: null,
    posterKey: null,
    pictures: pictures(keys),
    now: NOW,
  };
  return publishPost(db, post);
}

beforeEach(async () => {
  await reset();
  const stored = (await bucket.list()).objects.map((object) => object.key);
  if (stored.length > 0) await bucket.delete(stored);
  await user("u1", "quiet_otter", { plan: true });
  await user("u2", "other_otter", { plan: true });
});

describe("a gallery as sent", () => {
  it("is 2 to 10 different uploads, each with its size or the default", () => {
    const key = (n: number) => `${String(n).padStart(24, "a")}.jpg`;
    expect(readGallery([{ key: key(1), width: 10, height: 20 }, { upload: key(2) }])).toEqual([
      { key: key(1), width: 10, height: 20 },
      { key: key(2), width: 1200, height: 900 },
    ]);
    expect(readGallery(JSON.stringify([{ key: key(1) }, { key: key(2) }]))).toHaveLength(2);
    expect(readGallery([{ key: key(1) }])).toBeNull();
    expect(readGallery(Array.from({ length: GALLERY_MAX + 1 }, (_, n) => ({ key: key(n) })))).toBeNull();
    expect(readGallery([{ key: key(1) }, { key: key(1) }])).toBeNull();
    expect(readGallery([{ key: "../etc/passwd" }, { key: key(2) }])).toBeNull();
    expect(readGallery("not json")).toBeNull();
    expect(pictureAlt("Rain", 1, 5)).toBe("Rain, picture 2 of 5");
    expect(pictureAlt("Rain", 0, 1)).toBe("Rain");
  });
});

describe("pictures sent for a gallery", () => {
  it("gather in their set, up to ten, and any other file replaces them", async () => {
    const first = await send("u1", "set-one-aaaa");
    const second = await send("u1", "set-one-aaaa");
    expect(await pending("u1")).toEqual([first, second].sort());
    // Another set's picture replaces them, as one file always replaced the last.
    const other = await send("u1", "set-two-bbbb");
    expect(await pending("u1")).toEqual([other]);
    // So does a video, which never joins a set.
    const video = await send("u1", "set-two-bbbb", MP4);
    expect(await pending("u1")).toEqual([video]);
    for (let n = 0; n < GALLERY_MAX; n += 1) await send("u1", "set-three-cc");
    const eleventh = await storeUpload(db, bucket, { ownerId: "u1", body: stream(JPEG), length: JPEG.length, role: "media", set: "set-three-cc", now: NOW });
    expect(eleventh).toEqual({ ok: false, reason: "too_many" });
    // Taking one out makes room, and deletes its file.
    const [taken] = await pending("u1");
    expect(await releaseUpload(db, bucket, { ownerId: "u2", key: taken! })).toBe(false);
    expect(await releaseUpload(db, bucket, { ownerId: "u1", key: taken! })).toBe(true);
    expect(await bucket.get(taken!)).toBeNull();
    expect((await storeUpload(db, bucket, { ownerId: "u1", body: stream(JPEG), length: JPEG.length, role: "media", set: "set-three-cc", now: NOW })).ok).toBe(true);
  });
});

describe("publishing a gallery", () => {
  it("attaches every picture in one write, and reads back in order with the first as cover", async () => {
    const keys = [await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa")];
    expect(await galleryPost("u1", [keys[2]!, keys[0]!, keys[1]!])).toEqual({ ok: true, id: "gallery" });
    for (const key of keys) expect(await stateOf(key)).toBe("attached");
    const page = await postPage(db, "gallery");
    const media = page?.state === "live" ? page.post.media : null;
    expect(media).toMatchObject({ kind: "image", src: expect.stringContaining(keys[2]!), width: 1000, height: 800 });
    expect(media?.kind === "image" && media.pictures?.map((picture) => picture.src)).toEqual(
      [keys[2], keys[0], keys[1]].map((key) => expect.stringContaining(key!)),
    );
  });

  it("goes in with all of its pictures or none: another's, a video, or one gone refuses it", async () => {
    const mine = [await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa")];
    const theirs = await send("u2", "set-two-bbbb");
    expect(await galleryPost("u1", [...mine, theirs])).toEqual({ ok: false, reason: "not_allowed" });
    for (const key of mine) expect(await stateOf(key)).toBe("pending");
    expect(await galleryPost("u1", [...mine, `${"z".repeat(24)}.jpg`])).toEqual({ ok: false, reason: "not_allowed" });
    // The cover must be the first picture.
    const author = (await accountRecord(db, "u1", NOW))!;
    const misnamed = await publishPost(db, {
      kind: "upload", id: "misnamed", author, origin: "made", title: "A title", description: "A description of twenty.",
      mediaKey: mine[1]!, mediaType: "image", width: 1, height: 1, duration: null, posterKey: null, pictures: pictures(mine), now: NOW,
    });
    expect(misnamed).toEqual({ ok: false, reason: "not_allowed" });
    expect(await db.prepare(`SELECT COUNT(*) AS n FROM posts`).first()).toEqual({ n: 0 });
  });

  it("is swept whole once its author deletes it, and kept while a moderator's removal stands", async () => {
    const keys = [await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa")];
    await galleryPost("u1", keys);
    await db.prepare(`UPDATE posts SET deleted_at = ?1 WHERE id = 'gallery'`).bind(NOW + DAY).run();
    expect(await sweepDeletedUploads(db, bucket)).toBe(2);
    for (const key of keys) {
      expect(await bucket.get(key)).toBeNull();
      expect(await stateOf(key)).toBeNull();
    }
    expect(await db.prepare(`SELECT media_key, pictures FROM posts WHERE id = 'gallery'`).first()).toEqual({ media_key: null, pictures: null });
  });
});

describe("a gallery in a draft", () => {
  const fields = (keys: string[]): DraftFields => ({
    kind: "upload",
    url: null,
    origin: "made",
    title: "Rain on a street that never was",
    description: "Four frames from one prompt, a minute apart.",
    replies: null,
    mediaKey: keys[0] ?? null,
    width: 1000,
    height: 800,
    duration: null,
    posterKey: null,
    pictures: keys.length > 1 ? pictures(keys) : null,
  });

  it("keeps its pictures, takes a new order and cover, frees one taken out, and publishes as the gallery", async () => {
    const keys = [await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa")];
    const saved = await saveDraft(db, { authorId: "u1", fields: fields(keys), now: NOW });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    for (const key of keys) expect(await stateOf(key)).toBe("draft");
    expect(saved.draft.pictures?.map((picture) => picture.key)).toEqual(keys);
    // A later upload, in another set, leaves the draft's pictures alone.
    await send("u1", "set-two-bbbb");
    for (const key of keys) expect(await stateOf(key)).toBe("draft");
    // Reordered, with the third as cover, and the second taken out.
    const reordered = await saveDraft(db, { authorId: "u1", id: saved.draft.id, revision: 1, fields: fields([keys[2]!, keys[0]!]), now: NOW });
    expect(reordered).toMatchObject({ ok: true, freed: [keys[1]], draft: { media: { key: keys[2] }, revision: 2 } });
    expect(await stateOf(keys[1]!)).toBeNull();
    const published = await publishDraft(db, {
      id: saved.draft.id,
      actorId: "u1",
      as: "author",
      revision: 2,
      bucket,
      secret: env.BETTER_AUTH_SECRET,
      ownHosts: ["aion.ly"],
      mentionHosts: ["aion.ly"],
      now: NOW,
    });
    if (!published.ok) throw new Error(JSON.stringify(published));
    const page = await postPage(db, published.postId);
    const media = page?.state === "live" ? page.post.media : null;
    expect(media?.kind === "image" && media.pictures?.map((picture) => picture.src)).toEqual(
      [keys[2], keys[0]].map((key) => expect.stringContaining(key!)),
    );
    expect((await draftFor(db, saved.draft.id, "u1"))?.draft.postId).toBe(published.postId);
  });

  it("publishes from the form with a new cover, or with the cover taken out, unsaved (review F87)", async () => {
    const keys = [await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa"), await send("u1", "set-one-aaaa")];
    const saved = await saveDraft(db, { authorId: "u1", fields: fields(keys), now: NOW });
    if (!saved.ok) throw new Error(JSON.stringify(saved));
    const author = (await accountRecord(db, "u1", NOW))!;
    const fromForm = (id: string, order: string[], draft: { id: string; revision: number }): NewPost => ({
      kind: "upload", id, author, origin: "made", title: "Rain on a street that never was", description: "Four frames from one prompt, a minute apart.",
      mediaKey: order[0]!, mediaType: "image", width: 1000, height: 800, duration: null, posterKey: null,
      pictures: order.length > 1 ? pictures(order) : null, draft, now: NOW,
    });
    // The second moved first, then published without saving.
    expect(await publishPost(db, fromForm("reordered", [keys[1]!, keys[0]!, keys[2]!], { id: saved.draft.id, revision: 1 }))).toEqual({
      ok: true,
      id: "reordered",
    });
    for (const key of keys) expect(await stateOf(key)).toBe("attached");

    // Another draft of two, its cover taken out: the one picture left is the post's.
    const more = [await send("u1", "set-two-bbbb"), await send("u1", "set-two-bbbb")];
    const second = await saveDraft(db, { authorId: "u1", fields: fields(more), now: NOW });
    if (!second.ok) throw new Error(JSON.stringify(second));
    await db.prepare(`DELETE FROM posts`).run();
    expect(await publishPost(db, fromForm("single", [more[1]!], { id: second.draft.id, revision: 1 }))).toEqual({ ok: true, id: "single" });
    expect(await db.prepare(`SELECT media_key, pictures FROM posts WHERE id = 'single'`).first()).toEqual({ media_key: more[1], pictures: null });
    expect(await stateOf(more[1]!)).toBe("attached");
  });

  it("refuses a picture that is not the author's, or not a picture", async () => {
    const mine = await send("u1", "set-one-aaaa");
    const theirs = await send("u2", "set-two-bbbb");
    expect(await saveDraft(db, { authorId: "u1", fields: fields([mine, theirs]), now: NOW })).toEqual({ ok: false, reason: "file" });
    // A video the author holds pending beside the gallery's pictures.
    const video = `${"v".repeat(24)}.mp4`;
    await db
      .prepare(`INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at, upload_set) VALUES (?1, 'u1', 'media', 'pending', 'video/mp4', 10, ?2, 'set-one-aaaa')`)
      .bind(video, NOW)
      .run();
    expect(await saveDraft(db, { authorId: "u1", fields: fields([mine, video]), now: NOW })).toEqual({ ok: false, reason: "file" });
    expect(await galleryPost("u1", [mine, video])).toEqual({ ok: false, reason: "not_allowed" });
  });
});
