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

/** The sign-in pages, which a sign-in never returns to. */
const SIGN_IN_PAGE = /^\/signin(\/|$)/;
const SIGN_OUT = /^\/signout\/?$/;

/**
 * A path as the router matches it, decoded and in any case, so `/SIGNIN` and
 * `/%73ignin` are the sign-in page too (review F127).
 */
function routeOf(pathname: string): string {
  try {
    return decodeURIComponent(pathname).toLowerCase();
  } catch {
    return pathname.toLowerCase();
  }
}

/**
 * Reduces a caller-supplied return destination to a same-origin path. Anything
 * that is not a plain path starting with a single `/` becomes `/`. A sign-in
 * page stands for where it returns, unwrapped however deeply it nests, and
 * signing out for the home page: a crawler following the sign-in page's own
 * Sign in link nested them ever deeper (2026-10-22).
 */
export function safeReturnPath(
  value: string | null | undefined,
  siteOrigin: string,
): string {
  let current = value;
  for (let depth = 0; depth < 20; depth += 1) {
    const path = plainReturnPath(current, siteOrigin);
    const { pathname, searchParams } = new URL(path, siteOrigin);
    const route = routeOf(pathname);
    if (SIGN_OUT.test(route)) return "/";
    if (!SIGN_IN_PAGE.test(route)) return path;
    current = searchParams.get("next");
  }
  return "/";
}

/**
 * Where a sign-in from this page returns: the page itself, or, on a sign-in
 * page, where that one returns, so its links never nest it (2026-10-22). The
 * address is the visitor's to change, so it is checked as any other return
 * destination (review F126); it runs in the browser too, where a stand-in
 * origin serves, since only a path on the same site passes.
 */
export function returnHere(pathname: string, search: string): string {
  return safeReturnPath(`${pathname}${search}`, "https://site.invalid");
}

function plainReturnPath(value: string | null | undefined, siteOrigin: string): string {
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
  // Resolving dot segments can leave the path starting `//`, as
  // `/a/..//evil.example` does, which reads as another host, so the path
  // returned is checked as well (review F125).
  const path = `${url.pathname}${url.search}${url.hash}`;
  if (path.startsWith("//") || new URL(path, siteOrigin).origin !== siteOrigin) return "/";
  return path;
}
