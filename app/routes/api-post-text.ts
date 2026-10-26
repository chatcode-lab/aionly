import { env } from "cloudflare:workers";

import { mentionNames } from "~/lib/db/mentions.server";
import { articleFiles } from "~/lib/db/rows.server";
import { ROW_ID } from "~/lib/security/body";
import { mentionIds } from "~/lib/text/mentions";

import type { Route } from "./+types/api-post-text";

/**
 * A live post's whole description, for Show more on a feed's card, with the
 * current names of those it mentions and, for an article, the uploads it
 * places. Public, as the post's own page is; a removed or deleted post has
 * none to give.
 */
export async function loader({ params }: Route.LoaderArgs) {
  if (!ROW_ID.test(params.id)) return Response.json({ error: "not_found" }, { status: 404 });
  const row = await env.DB.prepare(
    `SELECT description, CASE WHEN kind = 'text' THEN inline_media END AS inline_media FROM posts
     WHERE id = ?1 AND deleted_at IS NULL AND removed_batch_id IS NULL`,
  )
    .bind(params.id)
    .first<{ description: string; inline_media: string | null }>();
  if (!row) return Response.json({ error: "not_found" }, { status: 404 });
  return Response.json({
    description: row.description,
    names: await mentionNames(env.DB, mentionIds(row.description)),
    files: articleFiles(row.inline_media),
  });
}
