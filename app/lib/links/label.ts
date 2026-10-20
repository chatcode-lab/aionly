/**
 * An address as people read it: no scheme, no www., no trailing slash, its
 * host in lower case. A port other than the scheme's own stays, so a label
 * cannot hide one (review F98).
 */
function asRead(address: string): string | null {
  const text = address.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!url.hostname.includes(".")) return null;
    const port = url.port ? `:${url.port}` : "";
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${port}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
  } catch {
    return null;
  }
}

/**
 * True when a written link's label is its own address, read as people read
 * it, so following it holds no surprise: `[example.com/a](https://www.example.com/a/)`.
 */
export function labelIsAddress(label: string, href: string): boolean {
  const read = asRead(label);
  return read !== null && read === asRead(href);
}
