// The board's own addresses, followed as links wherever they appear.
const SITE_HOSTS = ["aion.ly", "www.aion.ly"];

/**
 * The path for an address on the board itself, or null for anywhere else.
 * The path must stay on the board however a browser reads it: a path that
 * starts with two slashes, or holds a backslash or a control character, is
 * an outside address in disguise.
 */
export function sitePath(href: string, currentHost: string | undefined): string | null {
  let path = href;
  if (!href.startsWith("/")) {
    try {
      const url = new URL(href);
      const own = SITE_HOSTS.includes(url.host) || url.host === currentHost;
      const secure = url.protocol === "https:" || (url.protocol === "http:" && url.host === currentHost);
      if (!own || !secure) return null;
      path = `${url.pathname}${url.search}${url.hash}`;
    } catch {
      return null;
    }
  }
  if (path.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(path)) return null;
  const base = "https://board.invalid";
  try {
    return new URL(path, base).origin === base ? path : null;
  } catch {
    return null;
  }
}
