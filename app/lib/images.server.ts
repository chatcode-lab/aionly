import { participantCondition } from "./db/accounts.server";
import { newId } from "./ids";
import { fetchPublic, readCapped } from "./links/fetch.server";

/** The largest picture kept as a snapshot. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** A pending image older than this is swept away. */
export const PENDING_TTL_SECONDS = 24 * 3600;

type ImageType = "image/jpeg" | "image/png" | "image/webp";

/** A picture's bytes and its real type. */
type Picture = { bytes: Uint8Array<ArrayBuffer>; type: ImageType };

const EXTENSION: Record<ImageType, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

/**
 * How long browsers and Cloudflare's cache keep an image. Images are served
 * straight from the bucket's public domain: anyone with a key can load it,
 * and keys are 24 random characters that only pages on the board reveal.
 * Taking content down deletes the object; caches then drop it within this
 * time, or at once when the address is purged. A post's picture is a copy
 * of what its page already publishes; an avatar is personal, so it goes
 * sooner.
 */
const CACHE_CONTROL = {
  post: "public, max-age=86400",
  avatar: "public, max-age=3600",
} as const;

/**
 * A new image's key: random, with the extension of its real type, which is
 * what Cloudflare's cache goes by when it decides what to keep.
 */
function imageKey(type: ImageType): string {
  return `${newId(24)}.${EXTENSION[type]}`;
}

function storeOptions(type: ImageType, kind: keyof typeof CACHE_CONTROL): R2PutOptions {
  return {
    httpMetadata: { contentType: type, cacheControl: CACHE_CONTROL[kind], contentDisposition: "inline" },
  };
}

/**
 * The picture's real type from its first bytes. The server's own claim is
 * ignored: only JPEG, PNG, and WebP are kept.
 */
export function sniffImage(bytes: Uint8Array): ImageType | null {
  const at = (offset: number, ...values: number[]) =>
    values.every((value, index) => bytes[offset + index] === value);
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  // "RIFF", four bytes of size, then "WEBP".
  if (at(0, 0x52, 0x49, 0x46, 0x46) && at(8, 0x57, 0x45, 0x42, 0x50)) return "image/webp";
  return null;
}

/**
 * Fetches a picture for keeping: at most 2 MB, and only JPEG, PNG, or WebP by
 * its bytes. Null when it cannot be fetched or is not an allowed image.
 */
async function fetchImage(
  url: URL,
  signal: AbortSignal,
  ownHosts: readonly string[],
): Promise<{ bytes: Uint8Array<ArrayBuffer>; type: ImageType } | null> {
  try {
    const { response } = await fetchPublic(url, {
      accept: "image/webp,image/png,image/jpeg",
      signal,
      ownHosts,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return null;
    }
    const bytes = await readCapped(response, MAX_IMAGE_BYTES);
    const type = bytes && sniffImage(bytes);
    return bytes && type ? { bytes, type } : null;
  } catch {
    return null;
  }
}

/** A preview picture in the bucket, its row still to be written by whoever keeps it. */
export interface StoredSnapshot {
  key: string;
  type: string;
  bytes: number;
}

/**
 * Fetches a preview picture and puts it in the bucket under a new key. Null
 * when it could not be fetched or is not an allowed image.
 */
export async function storeSnapshot(
  bucket: R2Bucket,
  input: { url: URL; signal: AbortSignal; ownHosts: readonly string[] },
): Promise<StoredSnapshot | null> {
  const image = await fetchImage(input.url, input.signal, input.ownHosts);
  if (!image) return null;
  const key = imageKey(image.type);
  await bucket.put(key, image.bytes, storeOptions(image.type, "post"));
  return { key, type: image.type, bytes: image.bytes.byteLength };
}

/**
 * Fetches a preview picture and keeps it as the account's one pending image,
 * replacing any earlier one. Returns its key, or null when the picture could
 * not be fetched or is not an allowed image. Publishing attaches it.
 */
export async function snapshotImage(
  db: D1Database,
  bucket: R2Bucket,
  input: { ownerId: string; url: URL; signal: AbortSignal; ownHosts: readonly string[]; now: number },
): Promise<string | null> {
  const stored = await storeSnapshot(bucket, input);
  if (!stored) return null;
  const { key, type, bytes } = stored;
  // The rows this replaces come back from the same batch, so their files
  // are deleted even when two checks overlap.
  let displaced: string[];
  try {
    const [deleted] = await db.batch([
      db
        .prepare(`DELETE FROM images WHERE owner_id = ?1 AND kind = 'post' AND state = 'pending' RETURNING key`)
        .bind(input.ownerId),
      db
        .prepare(
          `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at)
           VALUES (?1, ?2, 'post', 'pending', ?3, ?4, ?5)`,
        )
        .bind(key, input.ownerId, type, bytes, input.now),
    ]);
    displaced = (deleted!.results as Array<{ key: string }>).map((row) => row.key);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  if (displaced.length > 0) await bucket.delete(displaced);
  return key;
}

/** Deletes pending images nobody published within a day. */
export async function sweepPendingImages(
  db: D1Database,
  bucket: R2Bucket,
  now: number,
): Promise<number> {
  const { results } = await db
    .prepare(`SELECT key FROM images WHERE state = 'pending' AND created_at < ?1 LIMIT 500`)
    .bind(now - PENDING_TTL_SECONDS)
    .all<{ key: string }>();
  if (results.length === 0) return 0;
  const keys = results.map((row) => row.key);
  await bucket.delete(keys);
  await db
    .prepare(`DELETE FROM images WHERE state = 'pending' AND key IN (SELECT value FROM json_each(?1))`)
    .bind(JSON.stringify(keys))
    .run();
  return keys.length;
}

export type PhotoResult = { ok: true } | { ok: false; reason: "no_photo" | "failed" };

/**
 * The side of a kept avatar, which is square: sharp at three times the
 * largest one shows on a page (56 px on a profile), yet light in a feed
 * showing many (owner's request, 2026-10-21).
 */
export const AVATAR_SIDE = 320;

/** A picture as `squareAvatar` makes it, the only kind kept as an avatar. */
export interface SquareAvatar {
  bytes: Uint8Array<ArrayBuffer>;
  type: "image/webp";
  side: number;
}

const streamOf = (bytes: Uint8Array<ArrayBuffer>) => new Response(bytes).body!;

/**
 * A picture made an avatar, through Cloudflare's Images binding: cropped
 * to a square about its center, at most `AVATAR_SIDE` across and never
 * enlarged, its first frame alone, as WebP, which keeps transparency and
 * carries no metadata, so nothing says where a photo was taken. Null when
 * the binding cannot read it.
 */
export async function squareAvatar(imaging: ImagesBinding, picture: Picture): Promise<SquareAvatar | null> {
  try {
    const info = await imaging.info(streamOf(picture.bytes));
    if (!("width" in info) || info.width < 1 || info.height < 1) return null;
    const side = Math.min(AVATAR_SIDE, info.width, info.height);
    const result = await imaging
      .input(streamOf(picture.bytes))
      .transform({ width: side, height: side, fit: "cover" })
      .output({ format: "image/webp", quality: 85, anim: false });
    return { bytes: new Uint8Array(await new Response(result.image()).arrayBuffer()), type: "image/webp", side };
  } catch (error) {
    console.error("avatar not squared", error);
    return null;
  }
}

/**
 * Makes `image`, squared, an account's avatar, or with null goes back to
 * the letter, and deletes the copy it replaces. Changing it is taking
 * part, so a ban on whoever acts (the account itself, or its agent)
 * refuses it.
 */
export async function replaceAvatar(
  db: D1Database,
  bucket: R2Bucket,
  input: { userId: string; actorId: string; image: SquareAvatar | null; now: number },
): Promise<boolean> {
  let key: string | null = null;
  if (input.image) {
    const { bytes, type } = input.image;
    key = imageKey(type);
    await bucket.put(key, bytes, storeOptions(type, "avatar"));
    try {
      const [, updated] = await db.batch([
        db
          .prepare(
            `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at)
             VALUES (?1, ?2, 'avatar', 'attached', ?3, ?4, ?5)`,
          )
          .bind(key, input.userId, type, bytes.byteLength, input.now),
        db
          .prepare(
            `UPDATE profiles SET avatar_key = ?1
             WHERE user_id = ?2 AND ${participantCondition(3, input.now)}`,
          )
          .bind(key, input.userId, input.actorId),
      ]);
      if (updated.meta.changes === 0) {
        await db.prepare(`DELETE FROM images WHERE key = ?1`).bind(key).run();
        await bucket.delete(key);
        return false;
      }
    } catch (error) {
      await bucket.delete(key);
      throw error;
    }
  } else {
    const updated = await db
      .prepare(
        `UPDATE profiles SET avatar_key = NULL
         WHERE user_id = ?1 AND ${participantCondition(2, input.now)}`,
      )
      .bind(input.userId, input.actorId)
      .run();
    if (updated.meta.changes === 0) return false;
  }

  // Every other picture this account had goes, found after the write, so
  // two changes at once still leave just the one in use.
  const { results: stale } = await db
    .prepare(
      `DELETE FROM images WHERE owner_id = ?1 AND kind = 'avatar'
         AND key IS NOT (SELECT avatar_key FROM profiles WHERE user_id = ?1)
       RETURNING key`,
    )
    .bind(input.userId)
    .all<{ key: string }>();
  if (stale.length > 0) await bucket.delete(stale.map((row) => row.key));
  return true;
}

/**
 * Turns the account's Google photo on or off. On keeps a copy, never a link
 * to Google, and shows it as the avatar; off goes back to the generated one
 * and deletes the copy.
 */
export async function setGooglePhoto(
  db: D1Database,
  bucket: R2Bucket,
  imaging: ImagesBinding,
  input: { userId: string; on: boolean; ownHosts: readonly string[]; now: number },
): Promise<PhotoResult> {
  let image: SquareAvatar | null = null;
  if (input.on) {
    const user = await db
      .prepare(`SELECT "image" FROM "user" WHERE "id" = ?1`)
      .bind(input.userId)
      .first<{ image: string | null }>();
    if (!user?.image) return { ok: false, reason: "no_photo" };
    let url: URL;
    try {
      url = new URL(user.image);
    } catch {
      return { ok: false, reason: "no_photo" };
    }
    const fetched = await fetchImage(url, AbortSignal.timeout(5000), input.ownHosts);
    image = fetched && (await squareAvatar(imaging, fetched));
    if (!image) return { ok: false, reason: "failed" };
  }
  const replaced = await replaceAvatar(db, bucket, { userId: input.userId, actorId: input.userId, image, now: input.now });
  return replaced ? { ok: true } : { ok: false, reason: "failed" };
}

/**
 * Uses a copy of the account's linked X photo as its avatar. Like the Google
 * photo, it is copied once, never linked to.
 */
export async function setXPhoto(
  db: D1Database,
  bucket: R2Bucket,
  imaging: ImagesBinding,
  input: { userId: string; ownHosts: readonly string[]; now: number },
): Promise<PhotoResult> {
  const row = await db
    .prepare(`SELECT x_photo_url FROM profiles WHERE user_id = ?1`)
    .bind(input.userId)
    .first<{ x_photo_url: string | null }>();
  if (!row?.x_photo_url) return { ok: false, reason: "no_photo" };
  let url: URL;
  try {
    url = new URL(row.x_photo_url);
  } catch {
    return { ok: false, reason: "no_photo" };
  }
  const fetched = await fetchImage(url, AbortSignal.timeout(5000), input.ownHosts);
  const image = fetched && (await squareAvatar(imaging, fetched));
  if (!image) return { ok: false, reason: "failed" };
  const replaced = await replaceAvatar(db, bucket, { userId: input.userId, actorId: input.userId, image, now: input.now });
  return replaced ? { ok: true } : { ok: false, reason: "failed" };
}

export type UploadResult = { ok: true } | { ok: false; reason: "too_large" | "not_image" | "failed" };

/**
 * Makes uploaded bytes an account's avatar: JPEG, PNG, or WebP by their
 * first bytes, 2 MB at most, squared. How an agent sets its own picture,
 * or its owner's.
 */
export async function setUploadedAvatar(
  db: D1Database,
  bucket: R2Bucket,
  imaging: ImagesBinding,
  input: { userId: string; actorId: string; bytes: Uint8Array<ArrayBuffer>; now: number },
): Promise<UploadResult> {
  if (input.bytes.byteLength > MAX_IMAGE_BYTES) return { ok: false, reason: "too_large" };
  const type = sniffImage(input.bytes);
  const image = type && (await squareAvatar(imaging, { bytes: input.bytes, type }));
  if (!image) return { ok: false, reason: "not_image" };
  const replaced = await replaceAvatar(db, bucket, { userId: input.userId, actorId: input.actorId, image, now: input.now });
  return replaced ? { ok: true } : { ok: false, reason: "failed" };
}
