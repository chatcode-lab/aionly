/**
 * Files a draft keeps (`images.state = 'draft'`), let go once no unpublished
 * draft uses them: on saving or deleting a draft, on publishing one, which
 * may leave out a file it held (review F92), and hourly for any left over.
 * Each is queued in `file_deletions` as its row goes, until the bucket has
 * deleted it too (review F94).
 */

const DAY = 24 * 3600;

/** SQL: no unpublished draft of the file's owner uses the file `{file}`. */
const unused = (file: string) =>
  `NOT EXISTS (SELECT 1 FROM drafts WHERE author_id = ${file}.owner_id AND post_id IS NULL
     AND (media_key = ${file}.key OR poster_key = ${file}.key
       OR EXISTS (SELECT 1 FROM json_each(drafts.pictures) AS kept WHERE json_extract(kept.value, '$.key') = ${file}.key)))`;

/**
 * Lets go of an account's draft files no unpublished draft uses any more:
 * queues their keys for the bucket and drops their rows, in this order, in
 * the caller's batch, whose last result returns the keys (review F94).
 * With `published`, only once that draft became that post in the same batch.
 */
export function releaseUnusedDraftFiles(
  db: D1Database,
  ownerId: string,
  published?: { draftId: string; postId: string },
): D1PreparedStatement[] {
  const where = `owner_id = ?1 AND state = 'draft' AND ${unused("images")}${
    published ? ` AND EXISTS (SELECT 1 FROM drafts WHERE id = ?2 AND post_id = ?3)` : ""
  }`;
  const bind = (statement: D1PreparedStatement) =>
    published ? statement.bind(ownerId, published.draftId, published.postId) : statement.bind(ownerId);
  return [
    bind(db.prepare(`INSERT INTO file_deletions (key, queued_at) SELECT key, unixepoch() FROM images WHERE ${where} ON CONFLICT (key) DO NOTHING`)),
    bind(db.prepare(`DELETE FROM images WHERE ${where} RETURNING key`)),
  ];
}

/** The keys a batch's release returned, from its last result. */
export function releasedKeys(results: D1Result[]): string[] {
  return ((results.at(-1)?.results ?? []) as Array<{ key: string }>).map((row) => row.key);
}

/**
 * Deletes released files from the bucket, then their place in the queue. A
 * failure leaves them queued for the hourly run, and never fails the
 * member's own action.
 */
export async function deleteReleasedFiles(db: D1Database, bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  try {
    await bucket.delete(keys);
    await db.prepare(`DELETE FROM file_deletions WHERE key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).run();
  } catch (error) {
    console.error("released files kept for the hourly run", error);
  }
}

/**
 * Hourly: queues draft files a day old that no unpublished draft uses and
 * no post of their owner names, then deletes every queued file from the
 * bucket, including those an earlier delete left, and forgets each only
 * once the bucket has let it go (review F92, F94).
 */
export async function sweepUnusedDraftFiles(db: D1Database, bucket: R2Bucket, now: number): Promise<number> {
  const orphan = `file.state = 'draft' AND file.created_at < ?1 AND ${unused("file")}
    AND NOT EXISTS (SELECT 1 FROM posts WHERE author_id = file.owner_id
      AND (media_key = file.key OR thumb_key = file.key
        OR EXISTS (SELECT 1 FROM json_each(posts.pictures) AS shown WHERE json_extract(shown.value, '$.key') = file.key)))`;
  await db.batch([
    db
      .prepare(
        `INSERT INTO file_deletions (key, queued_at) SELECT file.key, ?2 FROM images AS file WHERE ${orphan} LIMIT 500
         ON CONFLICT (key) DO NOTHING`,
      )
      .bind(now - DAY, now),
    db.prepare(`DELETE FROM images WHERE state = 'draft' AND key IN (SELECT key FROM file_deletions)`),
  ]);
  const { results } = await db.prepare(`SELECT key FROM file_deletions ORDER BY queued_at LIMIT 500`).all<{ key: string }>();
  if (results.length === 0) return 0;
  const keys = results.map((row) => row.key);
  await bucket.delete(keys);
  await db.prepare(`DELETE FROM file_deletions WHERE key IN (SELECT value FROM json_each(?1))`).bind(JSON.stringify(keys)).run();
  return keys.length;
}
