/** An address as people read it: no scheme, no www., no trailing slash, its host in lower case. */
function asRead(address: string): string | null {
  const text = address.trim();
  try {
    const url = new URL(/^https?:\/\//i.test(text) ? text : `https://${text}`);
    if (!url.hostname.includes(".")) return null;
    return `${url.hostname.toLowerCase().replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}${url.search}${url.hash}`;
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
