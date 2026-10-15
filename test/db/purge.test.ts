import { env } from "cloudflare:workers";
import { beforeEach, describe, expect, it } from "vitest";

import { purgePostMedia } from "../../app/lib/db/moderation.server";
import { db, NOW, post, reset, user } from "./fixtures";

const bucket = env.IMAGES;

beforeEach(async () => {
  await reset();
  await user("u1", "quiet_otter");
  await user("admin", "the_admin", { role: "admin" });
});

async function withFiles(id: string, removed: boolean) {
  await post(id, { author: "u1", removed });
  const thumb = `${id}thumbxxxxxxxxxxxxxxxx.jpg`;
  const media = `${id}mediaxxxxxxxxxxxxxxxx.mp4`;
  await db.batch([
    db.prepare(`UPDATE posts SET thumb_key = ?2, media_key = ?3, kind = 'upload', url = NULL, canonical_key = NULL, media_type = 'video' WHERE id = ?1`).bind(id, thumb, media),
    db.prepare(`INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at) VALUES (?1, 'u1', 'post', 'attached', 'image/jpeg', 3, ?3), (?2, 'u1', 'media', 'attached', 'video/mp4', 3, ?3)`).bind(thumb, media, NOW),
  ]);
  await bucket.put(thumb, "jpg");
  await bucket.put(media, "mp4");
  return { thumb, media };
}

describe("deleting a removed post's files", () => {
  it("deletes its upload and poster from the bucket and the database, and logs it", async () => {
    const { thumb, media } = await withFiles("p1", true);
    expect(await purgePostMedia(db, bucket, { postId: "p1", actorId: "admin", now: NOW })).toEqual([thumb, media]);
    expect(await bucket.get(thumb)).toBeNull();
    expect(await bucket.get(media)).toBeNull();
    expect(await db.prepare(`SELECT thumb_key, media_key FROM posts WHERE id = 'p1'`).first()).toEqual({ thumb_key: null, media_key: null });
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM images`).first<{ n: number }>())?.n).toBe(0);
    expect(await db.prepare(`SELECT action, target_id FROM mod_actions`).first()).toEqual({ action: "purge_media", target_id: "p1" });
  });

  it("leaves a live post alone: it must be removed first", async () => {
    const { media } = await withFiles("p2", false);
    expect(await purgePostMedia(db, bucket, { postId: "p2", actorId: "admin", now: NOW })).toBeNull();
    expect(await bucket.get(media)).not.toBeNull();
  });
});
