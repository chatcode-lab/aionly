const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * Rejects cross-site writes. Every state-changing request must carry an
 * `Origin` header equal to the origin it was sent to. React Router's built-in
 * check covers UI routes only and lets a missing header through, so this runs
 * first for every route, resource routes included.
 */
export function isSameOriginRequest(request: Request): boolean {
  if (SAFE_METHODS.has(request.method.toUpperCase())) return true;
  const origin = request.headers.get("Origin");
  if (!origin) return false;
  return origin === new URL(request.url).origin;
}

/**
 * Reduces a caller-supplied return destination to a same-origin path. Anything
 * that is not a plain path starting with a single `/` becomes `/`.
 */
export function safeReturnPath(
  value: string | null | undefined,
  siteOrigin: string,
): string {
  if (!value || !value.startsWith("/") || value.startsWith("//")) return "/";
  // Browsers read `\` as `/` and strip tabs and newlines while parsing, so
  // either could turn a path into a scheme-relative URL.
  if (/[\\\u0000-\u001f\u007f]/.test(value)) return "/";

  let url: URL;
  try {
    url = new URL(value, siteOrigin);
  } catch {
    return "/";
  }
  if (url.origin !== siteOrigin) return "/";
  return `${url.pathname}${url.search}${url.hash}`;
}
