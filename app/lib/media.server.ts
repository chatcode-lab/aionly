import { env } from "cloudflare:workers";

/**
 * The public address of a stored image. Deployed, the bucket has its own
 * domain behind Cloudflare's cache, so an image costs no Worker request and
 * no database lookup. Without one, as in local development and tests, the
 * Worker serves it at `/img/<key>`.
 */
export function imageAddress(key: string): string {
  return env.MEDIA_ORIGIN ? `${env.MEDIA_ORIGIN}/${key}` : `/img/${key}`;
}
