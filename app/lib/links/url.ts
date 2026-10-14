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

// Parameters that say where a visitor came from, never which page it is.
const TRACKING_PARAMS = new Set([
  "__hsfp",
  "__hssc",
  "__hstc",
  "_ga",
  "_gl",
  "_hsenc",
  "_hsmi",
  "aff",
  "aff_id",
  "affid",
  "affiliate",
  "affiliate_id",
  "clickid",
  "cmpid",
  "dclid",
  "ef_id",
  "epik",
  "fbclid",
  "gbraid",
  "gclid",
  "icid",
  "igsh",
  "igshid",
  "irclickid",
  "li_fat_id",
  "mc_cid",
  "mc_eid",
  "mkt_tok",
  "msclkid",
  "ncid",
  "ocid",
  "oly_anon_id",
  "oly_enc_id",
  "rb_clickid",
  "ref",
  "ref_id",
  "ref_src",
  "ref_url",
  "referral",
  "refid",
  "s_cid",
  "s_kwcid",
  "si",
  "spm",
  "srsltid",
  "trk",
  "ttclid",
  "twclid",
  "vero_id",
  "wbraid",
  "yclid",
]);

// Families of tracking parameters: Google, Matomo, HubSpot, Adobe, and more.
const TRACKING_PREFIXES = ["utm_", "pk_", "mtm_", "hsa_", "sc_", "piwik_", "matomo_"];

function isTrackingParam(name: string): boolean {
  const lower = name.toLowerCase();
  return TRACKING_PARAMS.has(lower) || TRACKING_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/**
 * True when a page's declared canonical address is the same page as the
 * one submitted: the same host, `www.` aside, and the same path, a trailing
 * slash aside. Its query then says which parameters matter. A canonical
 * pointing elsewhere, such as a site's home page, is ignored.
 */
export function isSamePage(canonical: URL, submitted: URL): boolean {
  const path = (url: URL) => url.pathname.replace(/\/+$/, "") || "/";
  return (
    canonical.protocol === "https:" &&
    displayHost(canonical) === displayHost(submitted) &&
    path(canonical) === path(submitted)
  );
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

/**
 * The address to store for an ordinary page: as given, without tracking
 * parameters or a fragment.
 */
export function cleanPageUrl(url: URL): string {
  const clean = new URL(url.href);
  clean.hash = "";
  for (const name of [...clean.searchParams.keys()]) {
    if (isTrackingParam(name)) clean.searchParams.delete(name);
  }
  return clean.href;
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
