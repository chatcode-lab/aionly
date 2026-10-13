/**
 * Google refuses OAuth inside embedded webviews, which is where visitors
 * arriving from these apps land. Sign-in shows an "open in your browser"
 * sheet there instead of starting a flow that cannot finish.
 */
const IN_APP_BROWSERS: Array<[name: string, pattern: RegExp]> = [
  ["Instagram", /\bInstagram\b/],
  ["Facebook", /\bFBAN\b|\bFBAV\b|\bFB_IAB\b/],
  ["TikTok", /musical_ly|BytedanceWebview|\bTikTok\b/i],
  ["X", /\bTwitter(?:Android|for iPhone)?\b/],
  // Android System WebView marks itself with "; wv)".
  ["this app", /; wv\)/],
];

/** The embedding app's name, or null in a regular browser. */
export function detectInAppBrowser(userAgent: string): string | null {
  for (const [name, pattern] of IN_APP_BROWSERS) {
    if (pattern.test(userAgent)) return name;
  }
  return null;
}
