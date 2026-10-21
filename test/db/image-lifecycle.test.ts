import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { AVATAR_SIDE, setUploadedAvatar, squareAvatar } from "../../app/lib/images.server";
import { storeUpload } from "../../app/lib/uploads.server";
import { DAY, db, NOW, reset, user } from "./fixtures";
import { BIG_PNG, TALL_JPEG, WIDE_PNG } from "./pictures";

const bucket = env.IMAGES;

/** A picture's type and size, as the Images binding reads it. */
const infoOf = async (bytes: Uint8Array<ArrayBuffer>) => env.IMAGING.info(new Response(bytes).body!);
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
  it("keeps an avatar squared, without its metadata, and only the picture in use", async () => {
    const first = await setUploadedAvatar(db, bucket, env.IMAGING, { userId: "u1", actorId: "u1", bytes: new Uint8Array(TALL_JPEG), now: NOW });
    const second = await setUploadedAvatar(db, bucket, env.IMAGING, { userId: "u1", actorId: "u1", bytes: new Uint8Array(TALL_JPEG), now: NOW });
    expect(first.ok && second.ok).toBe(true);
    const { results } = await db.prepare(`SELECT key FROM images WHERE owner_id = 'u1' AND kind = 'avatar'`).all<{ key: string }>();
    expect(results).toHaveLength(1);
    const current = await db.prepare(`SELECT avatar_key FROM profiles WHERE user_id = 'u1'`).first<{ avatar_key: string }>();
    expect(results[0]!.key).toBe(current!.avatar_key);
    const stored = new Uint8Array(await (await bucket.get(current!.avatar_key))!.arrayBuffer());
    expect(new TextDecoder().decode(TALL_JPEG)).toContain("Taken at home");
    expect(new TextDecoder().decode(stored)).not.toContain("Taken at home");
    expect(new TextDecoder().decode(stored)).not.toContain("Exif");
    expect(await infoOf(stored)).toMatchObject({ format: "image/webp", width: 20, height: 20 });
    expect(current!.avatar_key).toMatch(/\.webp$/);
    expect((await bucket.list()).objects.map((object) => object.key)).toEqual([current!.avatar_key]);
  });

  it("squares a picture about its center, at most 320 across and never enlarged (owner's request, 2026-10-21)", async () => {
    const wide = (await squareAvatar(env.IMAGING, { bytes: new Uint8Array(WIDE_PNG), type: "image/png" }))!;
    expect(wide).toMatchObject({ type: "image/webp", side: 20 });
    expect(await infoOf(wide.bytes)).toMatchObject({ format: "image/webp", width: 20, height: 20 });
    const big = (await squareAvatar(env.IMAGING, { bytes: new Uint8Array(BIG_PNG), type: "image/png" }))!;
    expect(await infoOf(big.bytes)).toMatchObject({ width: AVATAR_SIDE, height: AVATAR_SIDE });
    // What looks like a picture but cannot be read is no avatar.
    const broken = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
    expect(await squareAvatar(env.IMAGING, { bytes: broken, type: "image/png" })).toBeNull();
    expect(await setUploadedAvatar(db, bucket, env.IMAGING, { userId: "u1", actorId: "u1", bytes: broken, now: NOW })).toEqual({ ok: false, reason: "not_image" });
    expect((await bucket.list()).objects).toHaveLength(0);
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
