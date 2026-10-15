import { parseSubmittedUrl } from "./url";

/** How the board names itself to the sites it fetches previews from. */
export const PREVIEW_USER_AGENT =
  "Mozilla/5.0 (compatible; aionly-preview/1.0; +https://aion.ly)";

const MAX_REDIRECTS = 4;

export class FetchRefused extends Error {}

/**
 * Fetches a public `https` address for a link preview. Redirects are followed
 * by hand, and the address and every hop must pass the same rules as a
 * submitted link:
 * `https` on the default port, a public DNS name, no credentials, and never
 * the site itself. The caller's signal bounds the whole exchange.
 */
export async function fetchPublic(
  url: URL,
  options: { accept: string; signal: AbortSignal; ownHosts: readonly string[] },
): Promise<{ response: Response; finalUrl: URL }> {
  // The first address passes the same rules as every redirect, whoever
  // supplied it: a member's link, or a photo address another service gave.
  const first = parseSubmittedUrl(url.href, { ownHosts: options.ownHosts });
  if (!first.ok) throw new FetchRefused(`address refused: ${first.reason}`);
  let current = first.url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(current, {
      redirect: "manual",
      signal: options.signal,
      headers: {
        Accept: options.accept,
        "Accept-Language": "en",
        "User-Agent": PREVIEW_USER_AGENT,
      },
    });
    if (response.status < 300 || response.status >= 400) {
      return { response, finalUrl: current };
    }

    await response.body?.cancel();
    const location = response.headers.get("Location");
    if (!location) throw new FetchRefused("redirect without a location");
    const next = parseSubmittedUrl(new URL(location, current).href, {
      ownHosts: options.ownHosts,
    });
    if (!next.ok) throw new FetchRefused(`redirect refused: ${next.reason}`);
    current = next.url;
  }
  throw new FetchRefused("too many redirects");
}

/**
 * Reads a body up to `maxBytes`. Returns null, and stops downloading, as soon
 * as it would be longer.
 */
export async function readCapped(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | null> {
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel();
    return null;
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

/**
 * Reads at most `maxBytes` of a body and ignores the rest: enough of a page
 * for the metadata in its head, however long the page is.
 */
export async function readPrefix(
  response: Response,
  maxBytes: number,
): Promise<Uint8Array<ArrayBuffer>> {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  while (total < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value.subarray(0, maxBytes - total));
    total += Math.min(value.byteLength, maxBytes - total);
  }
  await reader.cancel().catch(() => {});
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}
