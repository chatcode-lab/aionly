import type { ShellProvider } from "./frames";

/** The `type` of the height message the shell posts to its parent. */
export const SHELL_HEIGHT_MESSAGE = "aionly:shell-height";

const SHELL_IDS: Record<ShellProvider, RegExp> = {
  x: /^\d{1,20}$/,
  instagram: /^[A-Za-z0-9_-]{1,40}$/,
};

export function isShellId(provider: ShellProvider, id: string): boolean {
  return SHELL_IDS[provider].test(id);
}

function attribute(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

/** A JSON string literal that cannot close its `<script>` element. */
function scriptString(value: string): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

function providerMarkup(
  provider: ShellProvider,
  id: string,
  theme: "light" | "dark",
  nonce: string,
): string {
  const safeId = attribute(id);
  const safeNonce = attribute(nonce);
  if (provider === "x") {
    return [
      `<blockquote class="twitter-tweet" data-dnt="true" data-theme="${theme}">`,
      `<a href="https://twitter.com/i/status/${safeId}">Post on X</a>`,
      `</blockquote>`,
      `<script nonce="${safeNonce}" async src="https://platform.twitter.com/widgets.js" charset="utf-8"></script>`,
    ].join("");
  }
  return [
    `<blockquote class="instagram-media" data-instgrm-permalink="https://www.instagram.com/p/${safeId}/" data-instgrm-version="14">`,
    `<a href="https://www.instagram.com/p/${safeId}/">Post on Instagram</a>`,
    `</blockquote>`,
    `<script nonce="${safeNonce}" async src="https://www.instagram.com/embed.js"></script>`,
  ].join("");
}

/**
 * The embed shell document: one provider blockquote, the provider's official
 * script, and a reporter that tells the parent how tall the content is. It
 * contains nothing about the viewer. Callers must validate the ID first.
 */
export function shellDocument(options: {
  provider: ShellProvider;
  id: string;
  nonce: string;
  siteOrigin: string;
  theme: "light" | "dark";
}): string {
  const { provider, id, nonce, siteOrigin, theme } = options;
  if (!isShellId(provider, id)) {
    throw new Error("embed shell called with an unvalidated ID");
  }

  // The shell is sandboxed to an opaque origin, so the parent matches these
  // messages by source window; the target origin still pins the recipient.
  const reporter = `(function(){var last=0;function report(){var height=Math.ceil(document.documentElement.getBoundingClientRect().height);if(height!==last){last=height;parent.postMessage({type:${scriptString(SHELL_HEIGHT_MESSAGE)},height:height},${scriptString(siteOrigin)});}}new ResizeObserver(report).observe(document.documentElement);report();})();`;

  return [
    `<!doctype html>`,
    `<html lang="en">`,
    `<head>`,
    `<meta charset="utf-8">`,
    `<meta name="viewport" content="width=device-width, initial-scale=1">`,
    `<meta name="robots" content="noindex">`,
    `<meta name="color-scheme" content="${theme}">`,
    `<title>Embedded post</title>`,
    `<style>html,body{margin:0;padding:0;background:transparent}body{display:flex;justify-content:center}blockquote{margin:0}</style>`,
    `</head>`,
    `<body>`,
    providerMarkup(provider, id, theme, nonce),
    `<script nonce="${attribute(nonce)}">${reporter}</script>`,
    `</body>`,
    `</html>`,
  ].join("\n");
}
