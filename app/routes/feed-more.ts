import { env } from "cloudflare:workers";

import { newPage, postsByIds } from "~/lib/db/feed.server";
import { parseRange, parseSort } from "~/lib/feed";

import type { Route } from "./+types/feed-more";

/**
 * The next page of the feed, for "Load more". Top asks for the next IDs of
 * the ranking snapshot it already holds; New sends its cursor.
 */
export async function loader({ request }: Route.LoaderArgs) {
  const url = new URL(request.url);

  if (parseSort(url.searchParams.get("sort")) === "new") {
    const page = await newPage(
      env.DB,
      parseRange(url.searchParams.get("range")) ?? "all",
      Math.floor(Date.now() / 1000),
      url.searchParams.get("cursor"),
    );
    return Response.json(page);
  }

  const ids = (url.searchParams.get("ids") ?? "").split(",");
  return Response.json({
    posts: await postsByIds(env.DB, ids),
    nextCursor: null,
  });
}
