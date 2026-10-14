import { buildSitePolicy } from "./csp";

export interface SecurityHeaderOptions {
  nonce: string;
  /** True on the Vite dev server. */
  dev: boolean;
  /** False everywhere except production, where pages may be indexed. */
  indexable: boolean;
}

/**
 * Applies the security baseline to a response. Every response gets the site
 * policy, replacing anything a route set itself.
 */
export function withSecurityHeaders(
  request: Request,
  response: Response,
  options: SecurityHeaderOptions,
): Response {
  const url = new URL(request.url);
  // Responses from `fetch` and redirects have immutable headers.
  const secured = new Response(response.body, response);
  const headers = secured.headers;

  headers.set(
    "Content-Security-Policy",
    buildSitePolicy({ nonce: options.nonce, dev: options.dev }),
  );
  headers.set("X-Frame-Options", "DENY");
  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=()",
  );
  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  // Pages can carry the signed-in account's own data, so nothing is shared
  // between visitors or kept without checking back. Routes that serve
  // something cacheable say so themselves.
  if (!headers.has("Cache-Control")) {
    headers.set("Cache-Control", "private, no-cache");
  }
  if (!options.indexable) {
    headers.set("X-Robots-Tag", "noindex");
  }

  return secured;
}
