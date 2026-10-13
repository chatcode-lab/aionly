import { SHELL_PATH_PREFIX } from "../embeds/frames";
import { buildSitePolicy } from "./csp";

export interface SecurityHeaderOptions {
  nonce: string;
  /** True on the Vite dev server. */
  dev: boolean;
  /** False everywhere except production, where pages may be indexed. */
  indexable: boolean;
}

/**
 * Applies the security baseline to a response. The embed shell is the one
 * response that keeps its own policy: it must be framed by the site and run a
 * provider script, both of which the site policy forbids.
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

  const isShell =
    url.pathname.startsWith(SHELL_PATH_PREFIX) &&
    headers.has("Content-Security-Policy");

  if (!isShell) {
    headers.set(
      "Content-Security-Policy",
      buildSitePolicy({
        nonce: options.nonce,
        siteOrigin: url.origin,
        dev: options.dev,
      }),
    );
    headers.set("X-Frame-Options", "DENY");
  }

  headers.set("X-Content-Type-Options", "nosniff");
  headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
  headers.set(
    "Permissions-Policy",
    "camera=(), geolocation=(), microphone=(), payment=()",
  );
  if (url.protocol === "https:") {
    headers.set("Strict-Transport-Security", "max-age=31536000");
  }
  if (!options.indexable) {
    headers.set("X-Robots-Tag", "noindex");
  }

  return secured;
}
