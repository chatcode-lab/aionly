import { entitledCondition, participantCondition } from "./db/accounts.server";
import { newId } from "./ids";
import { MAX_IMAGE_BYTES } from "./images.server";
import { type MediaType, sniffMedia, stripJpegMetadata, UPLOAD_LIMITS } from "./uploads";

/**
 * Uploads: pictures, video, and audio that fans post, which the board
 * hosts in the same bucket as its snapshots. A file's type is read from its
 * first bytes (see `sniffMedia`), never taken from the browser's word for
 * it. Nothing is transcoded.
 */

export type UploadRole = "media" | "poster";

export type UploadResult =
  | { ok: true; key: string; media: MediaType; contentType: string }
  | { ok: false; reason: "too_large" | "unsupported" | "empty" | "not_allowed" };

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
 * Keeps an uploaded file as the account's one pending upload, or a video's
 * poster frame as its one pending post image, replacing any earlier one.
 * Pictures are read whole and lose their metadata; video and audio stream
 * straight into the bucket. `length` is the request's declared size, which
 * the stream must match exactly.
 */
export async function storeUpload(
  db: D1Database,
  bucket: R2Bucket,
  input: { ownerId: string; body: ReadableStream<Uint8Array>; length: number; role: UploadRole; now: number },
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
  if (sniffed.media === "image") {
    let picture = await readAll(whole, input.length);
    if (sniffed.contentType === "image/jpeg") picture = stripJpegMetadata(picture);
    bytes = picture.length;
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
  // Uploads are the plan's, for a member who may take part; the write
  // checks both. The rows it displaces come back from the same batch, so
  // their files are deleted even when two uploads overlap.
  const allowed = (index: number) => `${participantCondition(index, input.now)} AND ${entitledCondition(index, input.now)}`;
  let displaced: string[];
  try {
    const [deleted, inserted] = await db.batch([
      db
        .prepare(`DELETE FROM images WHERE owner_id = ?1 AND kind = ?2 AND state = 'pending' AND ${allowed(1)} RETURNING key`)
        .bind(input.ownerId, kind),
      db
        .prepare(
          `INSERT INTO images (key, owner_id, kind, state, content_type, bytes, created_at)
           SELECT ?1, ?2, ?3, 'pending', ?4, ?5, ?6 WHERE ${allowed(2)}`,
        )
        .bind(key, input.ownerId, kind, sniffed.contentType, bytes, input.now),
    ]);
    if (inserted!.meta.changes === 0) {
      await bucket.delete(key);
      return { ok: false, reason: "not_allowed" };
    }
    displaced = (deleted!.results as Array<{ key: string }>).map((row) => row.key);
  } catch (error) {
    await bucket.delete(key);
    throw error;
  }
  if (displaced.length > 0) await bucket.delete(displaced);
  return { ok: true, key, media: sniffed.media, contentType: sniffed.contentType };
}

/**
 * Deletes the files of upload posts their authors deleted, as the
 * snapshot sweep does for link posts. A moderator's removal keeps them.
 */
export async function sweepDeletedUploads(db: D1Database, bucket: R2Bucket): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT image.key FROM images AS image
       JOIN posts AS post ON post.media_key = image.key
       WHERE image.kind = 'media' AND post.deleted_at IS NOT NULL AND post.removed_batch_id IS NULL
       LIMIT 200`,
    )
    .all<{ key: string }>();
  if (results.length === 0) return 0;
  const keys = results.map((row) => row.key);
  await bucket.delete(keys);
  const list = JSON.stringify(keys);
  await db.batch([
    db.prepare(`UPDATE posts SET media_key = NULL WHERE media_key IN (SELECT value FROM json_each(?1))`).bind(list),
    db.prepare(`DELETE FROM images WHERE key IN (SELECT value FROM json_each(?1))`).bind(list),
  ]);
  return keys.length;
}
