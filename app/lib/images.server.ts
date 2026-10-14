import { participantCondition } from "./db/accounts.server";
import { newId } from "./ids";
import { fetchPublic, readCapped } from "./links/fetch.server";

/** The largest picture kept as a snapshot. */
export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

/** A pending image older than this is swept away. */
export const PENDING_TTL_SECONDS = 24 * 3600;

type ImageType = "image/jpeg" | "image/png" | "image/webp";

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
  const image = await fetchImage(input.url, input.signal, input.ownHosts);
  if (!image) return null;
  const { bytes, type } = image;

  const key = newId(24);
  const { results: earlier } = await db
    .prepare(`SELECT key FROM images WHERE owner_id = ?1 AND kind = 'post' AND state = 'pending'`)
    .bind(input.ownerId)
    .all<{ key: string }>();

  await bucket.put(key, bytes, { httpMetadata: { contentType: type } });
  try {
    await db.batch([
      db
        .prepare(`DELETE FROM images WHERE owner_id = ?1 AND kind = 'post' AND state = 'pending'`)
        .bind(input.ownerId),
      db
        .prepare(
          `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at)
           VALUES (?1, ?2, 'post', 'pending', ?3, ?4, ?5)`,
        )
        .bind(key, input.ownerId, type, bytes.byteLength, input.now),
    ]);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  if (earlier.length > 0) await bucket.delete(earlier.map((row) => row.key));
  return key;
}

export type ImageAccess =
  | { visible: false }
  | { visible: true; public: boolean; contentType: string };

/**
 * Whether an image may be served, checked on every request. Public while it
 * is attached to a live post or is a current avatar; a pending image only to
 * its owner; nothing else at all.
 */
export async function imageAccess(
  db: D1Database,
  key: string,
  viewerId: string | null,
): Promise<ImageAccess> {
  const row = await db
    .prepare(
      `SELECT image.owner_id, image.state, image.content_type,
              EXISTS (SELECT 1 FROM posts WHERE thumb_key = image.key
                        AND deleted_at IS NULL AND removed_batch_id IS NULL) AS on_live_post,
              EXISTS (SELECT 1 FROM profiles WHERE avatar_key = image.key
                        AND deleted_at IS NULL) AS is_avatar
       FROM images AS image WHERE image.key = ?1`,
    )
    .bind(key)
    .first<{
      owner_id: string;
      state: "pending" | "attached";
      content_type: string;
      on_live_post: number;
      is_avatar: number;
    }>();
  if (!row) return { visible: false };
  if (row.state === "pending") {
    return row.owner_id === viewerId
      ? { visible: true, public: false, contentType: row.content_type }
      : { visible: false };
  }
  if (row.on_live_post || row.is_avatar) {
    return { visible: true, public: true, contentType: row.content_type };
  }
  return { visible: false };
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
 * Turns the account's Google photo on or off. On keeps a copy, never a link
 * to Google, and shows it as the avatar; off goes back to the generated one
 * and deletes the copy. Changing it is taking part, so a ban refuses it.
 */
export async function setGooglePhoto(
  db: D1Database,
  bucket: R2Bucket,
  input: { userId: string; on: boolean; ownHosts: readonly string[]; now: number },
): Promise<PhotoResult> {
  const current = await db
    .prepare(`SELECT avatar_key FROM profiles WHERE user_id = ?1`)
    .bind(input.userId)
    .first<{ avatar_key: string | null }>();
  const previous = current?.avatar_key ?? null;

  let key: string | null = null;
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
    const image = await fetchImage(url, AbortSignal.timeout(5000), input.ownHosts);
    if (!image) return { ok: false, reason: "failed" };
    key = newId(24);
    await bucket.put(key, image.bytes, { httpMetadata: { contentType: image.type } });
    try {
      const [, updated] = await db.batch([
        db
          .prepare(
            `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at)
             VALUES (?1, ?2, 'avatar', 'attached', ?3, ?4, ?5)`,
          )
          .bind(key, input.userId, image.type, image.bytes.byteLength, input.now),
        db
          .prepare(
            `UPDATE profiles SET avatar_key = ?1
             WHERE user_id = ?2 AND ${participantCondition(2, input.now)}`,
          )
          .bind(key, input.userId),
      ]);
      if (updated.meta.changes === 0) {
        await db.prepare(`DELETE FROM images WHERE key = ?1`).bind(key).run();
        await bucket.delete(key);
        return { ok: false, reason: "failed" };
      }
    } catch (error) {
      await bucket.delete(key);
      throw error;
    }
  } else {
    const updated = await db
      .prepare(
        `UPDATE profiles SET avatar_key = NULL
         WHERE user_id = ?1 AND ${participantCondition(1, input.now)}`,
      )
      .bind(input.userId)
      .run();
    if (updated.meta.changes === 0) return { ok: false, reason: "failed" };
  }

  if (previous && previous !== key) {
    await db.prepare(`DELETE FROM images WHERE key = ?1 AND kind = 'avatar'`).bind(previous).run();
    await bucket.delete(previous);
  }
  return { ok: true };
}
