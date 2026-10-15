import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { setUploadedAvatar } from "../../app/lib/images.server";
import { storeUpload } from "../../app/lib/uploads.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const bucket = env.IMAGES;

// A JPEG whose APP1 segment carries EXIF, as a phone's photo would, with where it was taken.
const JPEG = Uint8Array.from([0xff, 0xd8, 0xff, 0xe1, 0, 8, ...[..."Exif!!"].map((c) => c.charCodeAt(0)), 0xff, 0xda, 0, 4, 1, 2, 0xff, 0xd9]);
const MP4 = Uint8Array.from([0, 0, 0, 0x20, ...[..."ftypisom"].map((c) => c.charCodeAt(0)), ...new Array(80).fill(1)]);

const stream = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

beforeEach(async () => {
  await reset();
  const stored = (await bucket.list()).objects.map((object) => object.key);
  if (stored.length > 0) await bucket.delete(stored);
  await user("u1", "quiet_otter");
  await db.prepare(`UPDATE profiles SET plan_until = ?1 WHERE user_id = 'u1'`).bind(NOW + 30 * DAY).run();
});

describe("replacing pictures and uploads", () => {
  it("strips a JPEG avatar's metadata, and keeps only the picture in use", async () => {
    const first = await setUploadedAvatar(db, bucket, { userId: "u1", actorId: "u1", bytes: new Uint8Array(JPEG), now: NOW });
    const second = await setUploadedAvatar(db, bucket, { userId: "u1", actorId: "u1", bytes: new Uint8Array(JPEG), now: NOW });
    expect(first.ok && second.ok).toBe(true);
    const { results } = await db.prepare(`SELECT key FROM images WHERE owner_id = 'u1' AND kind = 'avatar'`).all<{ key: string }>();
    expect(results).toHaveLength(1);
    const current = await db.prepare(`SELECT avatar_key FROM profiles WHERE user_id = 'u1'`).first<{ avatar_key: string }>();
    expect(results[0]!.key).toBe(current!.avatar_key);
    const stored = new Uint8Array(await (await bucket.get(current!.avatar_key))!.arrayBuffer());
    expect(new TextDecoder().decode(stored)).not.toContain("Exif");
    expect((await bucket.list()).objects.map((object) => object.key)).toEqual([current!.avatar_key]);
  });

  it("leaves one upload and one file when two arrive at once", async () => {
    const upload = () => storeUpload(db, bucket, { ownerId: "u1", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    const results = await Promise.all([upload(), upload()]);
    expect(results.every((result) => result.ok)).toBe(true);
    const { results: rows } = await db.prepare(`SELECT key FROM images WHERE owner_id = 'u1' AND kind = 'media'`).all<{ key: string }>();
    expect(rows).toHaveLength(1);
    expect((await bucket.list()).objects.map((object) => object.key)).toEqual([rows[0]!.key]);
  });

  it("refuses an upload without the plan, keeping nothing", async () => {
    await db.prepare(`UPDATE profiles SET plan_until = NULL WHERE user_id = 'u1'`).run();
    const result = await storeUpload(db, bucket, { ownerId: "u1", body: stream(MP4), length: MP4.length, role: "media", now: NOW });
    expect(result).toEqual({ ok: false, reason: "not_allowed" });
    expect((await bucket.list()).objects).toEqual([]);
  });
});
