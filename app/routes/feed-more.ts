import { env } from "cloudflare:workers";

import { editorPick } from "~/lib/db/editors.server";
import { newPage, postsByIds } from "~/lib/db/feed.server";
import { viewerMarks } from "~/lib/db/marks.server";
import { parseRange, parseSort } from "~/lib/feed";
import type { PostCardData } from "~/lib/public-types";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/feed-more";

/**
 * The next page of the feed, for "Load more". Top asks for the next IDs of
 * the ranking snapshot it already holds; New sends its cursor.
 */
export async function loader({ request, context }: Route.LoaderArgs) {
  const url = new URL(request.url);
  const viewer = await viewerOf(context);
  const marks = (posts: PostCardData[]) =>
    viewerMarks(env.DB, viewer?.id ?? null, { posts: posts.map((post) => post.id) });

  if (parseSort(url.searchParams.get("sort")) === "new") {
    const page = await newPage(
      env.DB,
      parseRange(url.searchParams.get("range")) ?? "all",
      Math.floor(Date.now() / 1000),
      url.searchParams.get("cursor"),
    );
    // The announcement and the editor's pick are pinned above the feed, not repeated in it.
    const now = Math.floor(Date.now() / 1000);
    const announced = await env.DB.prepare(`SELECT post_id FROM pins WHERE slot = 'announcement'`).first<{ post_id: string }>();
    const pick = await editorPick(env.DB, now);
    const pinned = new Set([announced?.post_id, pick?.post?.id].filter(Boolean));
    const posts = page.posts.filter((post) => !pinned.has(post.id));
    return Response.json({ ...page, posts, marks: await marks(posts) });
  }

  const ids = (url.searchParams.get("ids") ?? "").split(",");
  const posts = await postsByIds(env.DB, ids);
  return Response.json({ posts, nextCursor: null, marks: await marks(posts) });
}
