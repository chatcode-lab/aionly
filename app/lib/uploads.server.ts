import { ARTICLE_MEDIA_MAX } from "./article";
import { entitledCondition, participantCondition } from "./db/accounts.server";
import { UPLOAD_SET } from "./gallery";
import { newId } from "./ids";
import { MAX_IMAGE_BYTES } from "./images.server";
import { type MediaType, pictureSize, type PictureSize, sniffMedia, stripJpegMetadata, UPLOAD_LIMITS } from "./uploads";

/**
 * Uploads: pictures, video, and audio that fans post, which the board
 * hosts in the same bucket as its snapshots. A file's type is read from its
 * first bytes (see `sniffMedia`), never taken from the browser's word for
 * it. Nothing is transcoded.
 */

export type UploadRole = "media" | "poster";

export type UploadResult =
  | { ok: true; key: string; media: MediaType; contentType: string; size: PictureSize | null }
  | { ok: false; reason: "too_large" | "unsupported" | "empty" | "not_allowed" | "too_many" };

const CACHE_CONTROL = "public, max-age=86400";

/** Reads the start of a stream, for sniffing, and gives back a stream of the whole. */
async function peek(body: ReadableStream<Uint8Array>, want: number): Promise<{ head: Uint8Array; whole: ReadableStream<Uint8Array> }> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  let done = false;
  while (length < want) {
    const next = await reader.read();
    if (next.done) {
      done = true;
      break;
    }
    chunks.push(next.value);
    length += next.value.length;
  }
  const head = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    head.set(chunk, at);
    at += chunk.length;
  }
  const whole = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk);
      if (done) controller.close();
    },
    async pull(controller) {
      const next = await reader.read();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
  return { head, whole };
}

async function readAll(stream: ReadableStream<Uint8Array>, length: number): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = new Uint8Array(length);
  let at = 0;
  const reader = stream.getReader();
  for (let next = await reader.read(); !next.done; next = await reader.read()) {
    if (at + next.value.length > length) {
      await reader.cancel();
      throw new Error("body longer than declared");
    }
    bytes.set(next.value, at);
    at += next.value.length;
  }
  if (at !== length) throw new Error("body shorter than declared");
  return bytes;
}

/**
 * Keeps an uploaded file as the account's pending upload, or a video's
 * poster frame as its one pending post image, replacing any earlier one. A
 * file sent with a `set`, one post's (a gallery's pictures, or an article's
 * files), joins the files pending in that set, up to ARTICLE_MEDIA_MAX, and
 * replaces only what is pending outside it. Pictures are read whole, lose
 * their metadata, and keep their size, read from their bytes; video and
 * audio stream straight into the bucket, with the size `size` says, if
 * any. `length` is the request's declared size, which the stream must
 * match exactly.
 */
export async function storeUpload(
  db: D1Database,
  bucket: R2Bucket,
  input: {
    ownerId: string;
    body: ReadableStream<Uint8Array>;
    length: number;
    role: UploadRole;
    set?: string | null;
    /** A video's size as its sender says; a picture's is read from it. */
    size?: PictureSize | null;
    now: number;
  },
): Promise<UploadResult> {
  if (input.length <= 0) return { ok: false, reason: "empty" };
  const { head, whole } = await peek(input.body, 16);
  const sniffed = sniffMedia(head);
  const poster = input.role === "poster";
  if (!sniffed || (poster && !["image/jpeg", "image/png", "image/webp"].includes(sniffed.contentType))) {
    await whole.cancel();
    return { ok: false, reason: "unsupported" };
  }
  if (input.length > (poster ? MAX_IMAGE_BYTES : UPLOAD_LIMITS[sniffed.media])) {
    await whole.cancel();
    return { ok: false, reason: "too_large" };
  }

  const key = `${newId(24)}.${sniffed.extension}`;
  const options: R2PutOptions = {
    httpMetadata: { contentType: sniffed.contentType, cacheControl: CACHE_CONTROL, contentDisposition: "inline" },
  };
  let bytes = input.length;
  let size = sniffed.media === "video" ? (input.size ?? null) : null;
  if (sniffed.media === "image") {
    let picture = await readAll(whole, input.length);
    if (sniffed.contentType === "image/jpeg") picture = stripJpegMetadata(picture);
    bytes = picture.length;
    size = pictureSize(picture);
    await bucket.put(key, picture, options);
  } else {
    // The bucket needs to know the length up front; this also refuses a body
    // that is not the length it declared.
    const fixed = new FixedLengthStream(input.length);
    const [stored, piped] = await Promise.allSettled([bucket.put(key, fixed.readable, options), whole.pipeTo(fixed.writable)]);
    if (stored.status === "rejected" || piped.status === "rejected" || !stored.value) {
      await bucket.delete(key).catch(() => undefined);
      throw new Error("upload was not stored: the body was cut short or ran long");
    }
  }

  const kind = poster ? "post" : "media";
  // A poster frame stands alone; any other file may join a set.
  const set = !poster && input.set && UPLOAD_SET.test(input.set) ? input.set : null;
  // Uploads are the plan's, for a member who may take part; the write
  // checks both. The rows it displaces come back from the same batch, so
  // their files are deleted even when two uploads overlap.
  const allowed = (index: number) => `${participantCondition(index, input.now)} AND ${entitledCondition(index, input.now)}`;
  const gathered = `(SELECT COUNT(*) FROM images WHERE owner_id = ?2 AND kind = 'media' AND state = 'pending' AND upload_set = ?7)`;
  let displaced: string[];
  try {
    const [deleted, inserted] = await db.batch([
      db
        .prepare(
          `DELETE FROM images WHERE owner_id = ?1 AND kind = ?2 AND state = 'pending'
             AND (?3 IS NULL OR upload_set IS NOT ?3) AND ${allowed(1)} RETURNING key`,
        )
        .bind(input.ownerId, kind, set),
      db
        .prepare(
          `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at, upload_set, width, height)
           SELECT ?1, ?2, ?3, 'pending', ?4, ?5, ?6, ?7, ?8, ?9 WHERE ${allowed(2)} AND (?7 IS NULL OR ${gathered} < ${ARTICLE_MEDIA_MAX})`,
        )
        .bind(key, input.ownerId, kind, sniffed.contentType, bytes, input.now, set, size?.width ?? null, size?.height ?? null),
    ]);
    if (inserted!.meta.changes === 0) {
      await bucket.delete(key);
      const full = set
        ? await db.prepare(`SELECT ${gathered} AS n`).bind(null, input.ownerId, null, null, null, null, set).first<{ n: number }>()
        : null;
      return { ok: false, reason: (full?.n ?? 0) >= ARTICLE_MEDIA_MAX ? "too_many" : "not_allowed" };
    }
    displaced = (deleted!.results as Array<{ key: string }>).map((row) => row.key);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  if (displaced.length > 0) await bucket.delete(displaced);
  return { ok: true, key, media: sniffed.media, contentType: sniffed.contentType, size };
}

/**
 * Lets go of one of the account's pending uploads, as when a picture is
 * taken out of a gallery before it is published, so it counts no more
 * toward its set. Whether there was one.
 */
export async function releaseUpload(db: D1Database, bucket: R2Bucket, input: { ownerId: string; key: string }): Promise<boolean> {
  const released = await db
    .prepare(`DELETE FROM images WHERE key = ?1 AND owner_id = ?2 AND kind = 'media' AND state = 'pending' RETURNING key`)
    .bind(input.key, input.ownerId)
    .first<{ key: string }>();
  if (released) await bucket.delete(released.key);
  return released !== null;
}

