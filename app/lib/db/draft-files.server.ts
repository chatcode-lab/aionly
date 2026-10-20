/**
 * Files a draft keeps (`images.state = 'draft'`), let go once no unpublished
 * draft uses them: on saving or deleting a draft, on publishing one, which
 * may leave out a file it held (review F92), and hourly for any left over.
 */

const DAY = 24 * 3600;

/** SQL: no unpublished draft of the file's owner uses the file `{file}`. */
const unused = (file: string) =>
  `NOT EXISTS (SELECT 1 FROM drafts WHERE author_id = ${file}.owner_id AND post_id IS NULL
     AND (media_key = ${file}.key OR poster_key = ${file}.key
       OR EXISTS (SELECT 1 FROM json_each(drafts.pictures) AS kept WHERE json_extract(kept.value, '$.key') = ${file}.key)))`;

/**
 * Deletes an account's draft files no unpublished draft uses any more,
 * returning their keys for the bucket; with `published`, only once that
 * draft became that post, in the same batch.
 */
export function unusedDraftFiles(
  db: D1Database,
  ownerId: string,
  published?: { draftId: string; postId: string },
): D1PreparedStatement {
  const statement = db.prepare(
    `DELETE FROM images WHERE owner_id = ?1 AND state = 'draft' AND ${unused("images")}${
      published ? ` AND EXISTS (SELECT 1 FROM drafts WHERE id = ?2 AND post_id = ?3)` : ""
    } RETURNING key`,
  );
  return published ? statement.bind(ownerId, published.draftId, published.postId) : statement.bind(ownerId);
}

/**
 * Hourly: draft files a day old that no unpublished draft uses, and no post
 * of their owner names, deleted with their objects. Publishing lets them go
 * as it happens; this catches any kept before it did.
 */
export async function sweepUnusedDraftFiles(db: D1Database, bucket: R2Bucket, now: number): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT file.key FROM images AS file
       WHERE file.state = 'draft' AND file.created_at < ?1 AND ${unused("file")}
         AND NOT EXISTS (SELECT 1 FROM posts WHERE author_id = file.owner_id
           AND (media_key = file.key OR thumb_key = file.key
             OR EXISTS (SELECT 1 FROM json_each(posts.pictures) AS shown WHERE json_extract(shown.value, '$.key') = file.key)))
       LIMIT 500`,
    )
    .bind(now - DAY)
    .all<{ key: string }>();
  if (results.length === 0) return 0;
  const keys = results.map((row) => row.key);
  // The rule again inside the delete, so a draft saved meanwhile keeps its file.
  const { results: deleted } = await db
    .prepare(
      `DELETE FROM images WHERE state = 'draft' AND key IN (SELECT value FROM json_each(?1)) AND ${unused("images")} RETURNING key`,
    )
    .bind(JSON.stringify(keys))
    .all<{ key: string }>();
  const gone = deleted.map((row) => row.key);
  if (gone.length > 0) await bucket.delete(gone);
  return gone.length;
}
