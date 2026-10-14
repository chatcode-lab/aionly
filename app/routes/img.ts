import { env } from "cloudflare:workers";

import { imageAccess } from "~/lib/images.server";
import { viewerOf } from "~/lib/viewer.server";

import type { Route } from "./+types/img";

const KEY = /^[0-9A-Za-z]{24}$/;

/**
 * An image snapshot, checked on every request. Public images may be kept by
 * browsers for five minutes, so a removal takes effect within that; they are
 * never marked immutable or kept at the edge. A pending image is its owner's
 * alone and never stored.
 */
export async function loader({ params, context }: Route.LoaderArgs) {
  if (!KEY.test(params.key)) return new Response("Not Found", { status: 404 });
  const viewer = await viewerOf(context);
  const access = await imageAccess(env.DB, params.key, viewer?.id ?? null);
  if (!access.visible) return new Response("Not Found", { status: 404 });

  const object = await env.IMAGES.get(params.key);
  if (!object) return new Response("Not Found", { status: 404 });
  return new Response(object.body, {
    headers: {
      "Content-Type": access.contentType,
      "Content-Length": String(object.size),
      "Cache-Control": access.public ? "public, max-age=300" : "private, no-store",
      "Content-Disposition": "inline",
    },
  });
}
