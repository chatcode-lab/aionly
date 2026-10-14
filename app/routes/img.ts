import { env } from "cloudflare:workers";

import { imageAddress } from "~/lib/media.server";

import type { Route } from "./+types/img";

const KEY = /^[0-9A-Za-z]{24}(?:\.(?:jpg|png|webp))?$/;

/**
 * Serves a stored image where the bucket has no public domain of its own,
 * as in local development and tests, the same way the domain would: by
 * key, to anyone, with the cache lifetime stored on the object. Where it
 * has one, an old address redirects there.
 */
export async function loader({ params }: Route.LoaderArgs) {
  if (!KEY.test(params.key)) return new Response("Not Found", { status: 404 });
  if (env.MEDIA_ORIGIN) return Response.redirect(imageAddress(params.key), 301);

  const object = await env.IMAGES.get(params.key);
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers({ "Content-Length": String(object.size) });
  object.writeHttpMetadata(headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "public, max-age=300");
  return new Response(object.body, { headers });
}
