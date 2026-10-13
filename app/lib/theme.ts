export const THEMES = ["system", "light", "dark"] as const;

export type Theme = (typeof THEMES)[number];

export const THEME_COOKIE = "theme";

export function parseTheme(value: unknown): Theme {
  return THEMES.includes(value as Theme) ? (value as Theme) : "system";
}

/** Reads the remembered theme from a `Cookie` header. */
export function readTheme(cookieHeader: string | null): Theme {
  if (!cookieHeader) return "system";
  for (const pair of cookieHeader.split(";")) {
    const [name, ...rest] = pair.trim().split("=");
    if (name === THEME_COOKIE) return parseTheme(rest.join("="));
  }
  return "system";
}

/**
 * The theme is a display preference, not a secret, so the cookie is readable
 * by the page. It is host-only: no `Domain` attribute.
 */
export function themeCookie(theme: Theme, secure: boolean): string {
  return [
    `${THEME_COOKIE}=${theme}`,
    "Path=/",
    "Max-Age=31536000",
    "SameSite=Lax",
    ...(secure ? ["Secure"] : []),
  ].join("; ");
}
