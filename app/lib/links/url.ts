import type { ParsedUrl } from "./types";

export const MAX_URL_LENGTH = 2048;

// Names that never resolve on the public internet, or are reserved for local
// and special use.
const NON_PUBLIC_TLDS = new Set([
  "arpa",
  "corp",
  "example",
  "home",
  "internal",
  "invalid",
  "lan",
  "local",
  "localhost",
  "onion",
  "test",
]);

const TRACKING_PARAMS = new Set([
  "_hsenc",
  "_hsmi",
  "dclid",
  "fbclid",
  "gbraid",
  "gclid",
  "igsh",
  "igshid",
  "mc_cid",
  "mc_eid",
  "msclkid",
  "ttclid",
  "twclid",
  "wbraid",
  "yclid",
]);

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return lower.startsWith("utm_") || TRACKING_PARAMS.has(lower);
}

/** Lowercased hostname without a trailing root dot. */
export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/\.$/, "");
}

/**
 * True for names that can only be public DNS hostnames: at least two labels,
 * no IP literals, and a top-level label that is not reserved.
 */
export function isPublicHostname(hostname: string): boolean {
  const host = normalizeHost(hostname);
  if (host.length === 0 || host.length > 253) return false;
  // IPv6 literals keep their brackets in `URL.hostname`.
  if (host.startsWith("[")) return false;

  const labels = host.split(".");
  if (labels.length < 2) return false;
  if (labels.some((label) => label.length === 0 || label.length > 63)) {
    return false;
  }

  // The URL parser rewrites every IPv4 spelling, including hex and octal, to
  // dotted decimal, so a numeric top-level label always means an IP literal.
  const tld = labels[labels.length - 1];
  if (!/^(?:[a-z]{2,63}|xn--[a-z0-9-]{1,59})$/.test(tld)) return false;
  return !NON_PUBLIC_TLDS.has(tld);
}

/**
 * Validates a submitted link against the plan's URL rules: `https` on the
 * default port, a public DNS name, no embedded credentials, and never one of
 * the site's own hostnames.
 */
export function parseSubmittedUrl(
  input: string,
  options: { ownHosts?: readonly string[] } = {},
): ParsedUrl {
  const trimmed = input.trim();
  if (trimmed.length === 0) return { ok: false, reason: "empty" };
  if (trimmed.length > MAX_URL_LENGTH) return { ok: false, reason: "too_long" };

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return { ok: false, reason: "invalid" };
  }

  if (url.protocol !== "https:") return { ok: false, reason: "not_https" };
  if (url.username !== "" || url.password !== "") {
    return { ok: false, reason: "credentials" };
  }
  // `URL` drops the default port, so anything left is a non-default one.
  if (url.port !== "") return { ok: false, reason: "port" };
  if (!isPublicHostname(url.hostname)) {
    return { ok: false, reason: "host_not_public" };
  }

  const host = normalizeHost(url.hostname);
  const ownHosts = (options.ownHosts ?? []).map(normalizeHost);
  if (ownHosts.some((own) => host === own || host.endsWith(`.${own}`))) {
    return { ok: false, reason: "own_host" };
  }

  return { ok: true, url };
}

/** The host as shown beside a title: lowercased, without `www.`. */
export function displayHost(url: URL): string {
  return normalizeHost(url.hostname).replace(/^www\./, "");
}

/**
 * The duplicate-detection form of a generic page URL: host without `www.`,
 * path without a trailing slash, and the remaining query sorted, with
 * tracking parameters and the fragment dropped.
 */
export function canonicalizePageUrl(url: URL): string {
  const host = displayHost(url);
  const path = url.pathname.length > 1 ? url.pathname.replace(/\/+$/, "") : "";

  const params = [...url.searchParams.entries()]
    .filter(([name]) => !isTrackingParam(name))
    .sort(([aName, aValue], [bName, bValue]) =>
      aName === bName ? aValue.localeCompare(bValue) : aName.localeCompare(bName),
    );
  const query = new URLSearchParams(params).toString();

  return `${host}${path}${query ? `?${query}` : ""}`;
}
