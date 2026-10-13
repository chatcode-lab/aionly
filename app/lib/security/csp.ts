import {
  FRAME_ORIGINS,
  SHELL_PATH_PREFIX,
  SHELL_SANDBOX,
  type ShellProvider,
} from "../embeds/frames";

const TURNSTILE_ORIGIN = "https://challenges.cloudflare.com";
const GOOGLE_ACCOUNTS_ORIGIN = "https://accounts.google.com";

/** A fresh, unguessable value for one response's inline scripts. */
export function createNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

function serialize(directives: Record<string, readonly string[]>): string {
  return Object.entries(directives)
    .map(([name, values]) => [name, ...values].join(" "))
    .join("; ");
}

export interface SitePolicyOptions {
  nonce: string;
  siteOrigin: string;
  /** Loosens `connect-src` for the Vite dev server's HMR socket. */
  dev?: boolean;
}

/**
 * The policy for every first-party response except the embed shell. Only
 * first-party scripts and Turnstile may run, frames are limited to the
 * supported providers and the shell path, and the site can never be framed.
 */
export function buildSitePolicy({
  nonce,
  siteOrigin,
  dev = false,
}: SitePolicyOptions): string {
  return serialize({
    "default-src": ["'self'"],
    "script-src": ["'self'", `'nonce-${nonce}'`, TURNSTILE_ORIGIN],
    // Server-rendered `style` attributes carry aspect ratios and avatar
    // colors. Styles cannot run code, so this is the one inline allowance.
    "style-src": ["'self'", "'unsafe-inline'"],
    "img-src": ["'self'", "data:"],
    "font-src": ["'self'"],
    "connect-src": dev ? ["'self'", "ws:"] : ["'self'"],
    "frame-src": [
      ...Object.values(FRAME_ORIGINS),
      TURNSTILE_ORIGIN,
      `${siteOrigin}${SHELL_PATH_PREFIX}`,
    ],
    "frame-ancestors": ["'none'"],
    "base-uri": ["'self'"],
    // Chrome applies `form-action` to redirects after a form post, which the
    // Google sign-in redirect is.
    "form-action": ["'self'", GOOGLE_ACCOUNTS_ORIGIN],
    "object-src": ["'none'"],
  });
}

const SHELL_SCRIPT_ORIGINS: Record<ShellProvider, string> = {
  x: "https://platform.twitter.com",
  instagram: "https://www.instagram.com",
};

export interface ShellPolicyOptions {
  nonce: string;
  siteOrigin: string;
  provider: ShellProvider;
}

/**
 * The policy for the embed shell, sent instead of the site policy. The
 * `sandbox` directive puts the document at an opaque origin, so the provider's
 * script cannot reach first-party cookies, storage, or DOM. Only the site may
 * frame it.
 */
export function buildShellPolicy({
  nonce,
  siteOrigin,
  provider,
}: ShellPolicyOptions): string {
  return serialize({
    sandbox: SHELL_SANDBOX.split(" "),
    "default-src": ["'none'"],
    "script-src": [`'nonce-${nonce}'`, SHELL_SCRIPT_ORIGINS[provider]],
    "frame-src": [FRAME_ORIGINS[provider]],
    "style-src": ["'unsafe-inline'"],
    "frame-ancestors": [siteOrigin],
    "base-uri": ["'none'"],
    "form-action": ["'none'"],
  });
}
