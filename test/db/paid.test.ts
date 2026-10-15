import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { accountRecord } from "../../app/lib/db/accounts.server";
import { postPage } from "../../app/lib/db/posts.server";
import { publishPost } from "../../app/lib/db/submit.server";
import { dueRecipients, readUnsubscribeToken, sendDigests, setDigest, unsubscribeToken } from "../../app/lib/digest/digest.server";
import { storeUpload, sweepDeletedUploads } from "../../app/lib/uploads.server";
import { DAY, db, NOW, post, reset, user } from "./fixtures";

const bucket = env.IMAGES;

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      // In pieces, as a network body arrives.
      for (let at = 0; at < bytes.length; at += 7) controller.enqueue(bytes.slice(at, at + 7));
      controller.close();
    },
  });

const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), ...new Array(80).fill(1)]);
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, ...[..."Exif!!"].map((c) => c.charCodeAt(0)), 0xff, 0xda, 0, 4, 1, 2, 0xff, 0xd9]);

async function supporter(id: string, name: string) {
  await user(id, name);
  await db.prepare(`UPDATE profiles SET plan_until = ?2 WHERE user_id = ?1`).bind(id, NOW + 30 * DAY).run();
}

const record = async (id: string) => (await accountRecord(db, id, NOW))!;

beforeEach(async () => {
  await reset();
  await supporter("fan", "quiet_otter");
  await user("free", "paper_lark");
});

describe("uploads", () => {
  it("streams a video into the bucket as the account's one pending upload", async () => {
    const first = await storeUpload(db, bucket, { ownerId: "fan", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    expect(first).toMatchObject({ ok: true, media: "video", contentType: "video/mp4" });
    const second = await storeUpload(db, bucket, { ownerId: "fan", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    const { results } = await db.prepare(`SELECT key FROM images WHERE owner_id = 'fan' AND kind = 'media'`).all<{ key: string }>();
    expect(results.map((row) => row.key)).toEqual([second.ok ? second.key : ""]);
    // The replaced one is gone from the bucket too.
    expect(await bucket.head(first.ok ? first.key : "")).toBeNull();
    expect((await bucket.head(second.ok ? second.key : ""))?.httpMetadata?.contentType).toBe("video/mp4");
  });

  it("removes a photo's metadata, and refuses what is not a picture, video, or audio", async () => {
    const photo = await storeUpload(db, bucket, { ownerId: "fan", body: stream(JPEG), length: JPEG.length, role: "media", now: NOW });
    const kept = new Uint8Array(await (await bucket.get(photo.ok ? photo.key : ""))!.arrayBuffer());
    expect(new TextDecoder("latin1").decode(kept)).not.toContain("Exif");
    const page = new TextEncoder().encode("<!doctype html><script>alert(1)</script>");
    expect(await storeUpload(db, bucket, { ownerId: "fan", body: stream(page), length: page.length, role: "media", now: NOW })).toEqual({
      ok: false,
      reason: "unsupported",
    });
  });

  it("refuses a body longer than it declared", async () => {
    await expect(
      storeUpload(db, bucket, { ownerId: "fan", body: stream(MP4), length: MP4.length - 10, role: "media", now: NOW }),
    ).rejects.toThrow();
  });

  it("publishes an upload post with its poster, for a supporter only", async () => {
    const media = await storeUpload(db, bucket, { ownerId: "fan", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    const poster = await storeUpload(db, bucket, { ownerId: "fan", body: stream(JPEG), length: JPEG.length, role: "poster", now: NOW });
    const upload = {
      kind: "upload" as const,
      id: "up1",
      origin: "made" as const,
      title: "Forty seconds of rain",
      description: "Generated, then graded by hand for the light.",
      now: NOW,
      mediaKey: media.ok ? media.key : "",
      mediaType: "video" as const,
      width: 1080,
      height: 1920,
      duration: 40,
      posterKey: poster.ok ? poster.key : null,
    };
    expect(await publishPost(db, { ...upload, author: await record("fan") })).toEqual({ ok: true, id: "up1" });
    const page = await postPage(db, "up1");
    expect(page?.state === "live" && page.post.media).toMatchObject({ kind: "video", aspect: "9:16", duration: 40 });
    expect(page?.state === "live" && page.post.host).toBeUndefined();
    const states = await db.prepare(`SELECT state FROM images WHERE owner_id = 'fan'`).all<{ state: string }>();
    expect(states.results.every((row) => row.state === "attached")).toBe(true);

    // Without the plan, nothing is published, whatever the request says.
    const theirs = await storeUpload(db, bucket, { ownerId: "free", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    expect(await publishPost(db, { ...upload, id: "up2", mediaKey: theirs.ok ? theirs.key : "", posterKey: null, author: await record("free") })).toEqual({
      ok: false,
      reason: "not_allowed",
    });
  });

  it("sweeps the file of an upload its author deleted", async () => {
    const media = await storeUpload(db, bucket, { ownerId: "fan", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    const key = media.ok ? media.key : "";
    await publishPost(db, {
      kind: "upload", id: "up3", origin: "made", title: "A clip", description: "A clip made with a video model.", now: NOW,
      mediaKey: key, mediaType: "video", width: null, height: null, duration: null, posterKey: null, author: await record("fan"),
    });
    await db.prepare(`UPDATE posts SET deleted_at = ?1 WHERE id = 'up3'`).bind(NOW).run();
    expect(await sweepDeletedUploads(db, bucket)).toBe(1);
    expect(await bucket.head(key)).toBeNull();
  });
});

describe("text posts", () => {
  const text = (id: string) => ({
    kind: "text" as const,
    id,
    origin: "made" as const,
    title: "A prompt that writes better commit messages",
    description: "Here is the prompt, and what it does well and badly.",
    now: NOW,
  });

  it("publish for a supporter or an admin, never for a free member", async () => {
    expect(await publishPost(db, { ...text("t1"), author: await record("fan") })).toEqual({ ok: true, id: "t1" });
    const page = await postPage(db, "t1");
    const shown = page?.state === "live" ? page.post : null;
    expect(shown).toMatchObject({ url: shown?.path, media: { kind: "text" } });
    expect(await publishPost(db, { ...text("t2"), author: await record("free") })).toEqual({ ok: false, reason: "not_allowed" });
    await user("boss", "head_admin", { role: "admin" });
    expect(await publishPost(db, { ...text("t3"), author: await record("boss") })).toEqual({ ok: true, id: "t3" });
  });
});

describe("the digest", () => {
  const sent: Array<{ to: string; subject: string; headers?: Record<string, string> }> = [];
  const mailer = { send: async (message: { to: string; subject: string; headers?: Record<string, string> }) => (sent.push(message), { messageId: "m" }) } as unknown as SendEmail;
  const iso = new Date(NOW * 1000).toISOString();
  const email = (id: string) =>
    db
      .prepare(`INSERT INTO "user" ("id", "name", "email", "emailVerified", "createdAt", "updatedAt") VALUES (?1, 'n', ?2, 1, ?3, ?3)`)
      .bind(id, `${id}@example.invalid`, iso)
      .run();

  beforeEach(async () => {
    sent.length = 0;
    await db.prepare(`DELETE FROM "user"`).run();
    await email("fan");
    await email("free");
  });

  it("goes to supporters who turned it on, once a period, with a one-click unsubscribe", async () => {
    await setDigest(db, "fan", "weekly", NOW - 8 * DAY);
    await db.prepare(`UPDATE profiles SET digest = 'weekly' WHERE user_id = 'free'`).run();
    expect((await dueRecipients(db, "weekly", NOW)).map((row) => row.userId)).toEqual(["fan"]);

    await post("p1", { author: "free", age: 3600, score: 5 });
    const input = { origin: "https://aion.ly", secret: "s", from: "digest@aion.ly", now: NOW };
    expect(await sendDigests(db, mailer, input)).toBe(1);
    expect(sent[0]).toMatchObject({ to: "fan@example.invalid", headers: { "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" } });
    // Sent for this period; the next run sends nothing more.
    expect(await sendDigests(db, mailer, { ...input, now: NOW + 3600 })).toBe(0);
  });

  it("starts with the next period when turned on, and counts a quiet period as sent", async () => {
    await setDigest(db, "fan", "daily", NOW);
    expect(await dueRecipients(db, "daily", NOW + 3600)).toEqual([]);
    expect(await sendDigests(db, mailer, { origin: "https://aion.ly", secret: "s", from: "digest@aion.ly", now: NOW + 2 * DAY })).toBe(0);
    expect(await dueRecipients(db, "daily", NOW + 2 * DAY)).toEqual([]);
  });

  it("unsubscribes by a signed token, which cannot be made for someone else", async () => {
    const token = await unsubscribeToken("s", "fan");
    expect(await readUnsubscribeToken("s", token)).toBe("fan");
    expect(await readUnsubscribeToken("s", token.replace("fan.", "free."))).toBeNull();
    expect(await readUnsubscribeToken("other", token)).toBeNull();
  });
});
