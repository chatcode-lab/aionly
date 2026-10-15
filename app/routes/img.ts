import { env } from "cloudflare:workers";

import { imageAddress } from "~/lib/media.server";

import type { Route } from "./+types/img";

const KEY = /^[0-9A-Za-z]{24}(?:\.(?:jpg|png|webp|gif|avif|mp4|mov|webm|mp3|m4a|ogg|wav|flac))?$/;

/**
 * Serves a stored image where the bucket has no public domain of its own,
 * as in local development and tests, the same way the domain would: by
 * key, to anyone, with the cache lifetime stored on the object. Where it
 * has one, an old address redirects there.
 */
export async function loader({ params, request }: Route.LoaderArgs) {
  if (!KEY.test(params.key)) return new Response("Not Found", { status: 404 });
  if (env.MEDIA_ORIGIN) return Response.redirect(imageAddress(params.key), 301);

  // Players ask for video and audio in ranges, as the bucket's domain serves them.
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("Range") ?? "");
  const object = await env.IMAGES.get(
    params.key,
    range ? { range: { offset: Number(range[1]), ...(range[2] ? { length: Number(range[2]) - Number(range[1]) + 1 } : {}) } } : {},
  );
  if (!object) return new Response("Not Found", { status: 404 });
  const headers = new Headers({ "Accept-Ranges": "bytes" });
  object.writeHttpMetadata(headers);
  if (!headers.has("Cache-Control")) headers.set("Cache-Control", "public, max-age=300");
  if (range && object.range && "offset" in object.range) {
    const offset = object.range.offset ?? 0;
    const length = object.range.length ?? object.size - offset;
    headers.set("Content-Range", `bytes ${offset}-${offset + length - 1}/${object.size}`);
    headers.set("Content-Length", String(length));
    return new Response(object.body, { status: 206, headers });
  }
  headers.set("Content-Length", String(object.size));
  return new Response(object.body, { headers });
}
