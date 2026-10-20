/**
 * Tint, a fan's choice in Settings under Display: the color that stands in
 * for the board's orange everywhere they look, their fan marks and the
 * emails they get included, in both color schemes (owner's request,
 * 2026-10-20). No blue: downvotes are indigo. Kept on the profile
 * (`profiles.tint`, null for orange), and in force while the plan is.
 * app.css holds the same colors, which a test compares with these.
 */

export const TINTS = ["orange", "rose", "magenta", "green", "teal"] as const;

export type Tint = (typeof TINTS)[number];

export const DEFAULT_TINT: Tint = "orange";

export const TINT_LABEL: Record<Tint, string> = {
  orange: "Orange",
  rose: "Rose",
  magenta: "Magenta",
  green: "Green",
  teal: "Teal",
};

export interface TintColors {
  accent: string;
  "accent-solid": string;
  "on-accent": string;
  "accent-soft": string;
}

/** Each tint's colors in the light and dark schemes; emails use the light ones. */
export const TINT_COLORS: Record<Tint, { light: TintColors; dark: TintColors }> = {
  orange: {
    light: { accent: "#c2410c", "accent-solid": "#c2410c", "on-accent": "#ffffff", "accent-soft": "#fff1e8" },
    dark: { accent: "#ff9a5c", "accent-solid": "#ff9a5c", "on-accent": "#1b1a18", "accent-soft": "#3a2415" },
  },
  rose: {
    light: { accent: "#be123c", "accent-solid": "#be123c", "on-accent": "#ffffff", "accent-soft": "#ffecef" },
    dark: { accent: "#ff8ca3", "accent-solid": "#ff8ca3", "on-accent": "#1b1a18", "accent-soft": "#3b1820" },
  },
  magenta: {
    light: { accent: "#a21caf", "accent-solid": "#a21caf", "on-accent": "#ffffff", "accent-soft": "#fbecfd" },
    dark: { accent: "#ef8cf5", "accent-solid": "#ef8cf5", "on-accent": "#1b1a18", "accent-soft": "#341838" },
  },
  green: {
    light: { accent: "#137a3b", "accent-solid": "#137a3b", "on-accent": "#ffffff", "accent-soft": "#e9f6ee" },
    dark: { accent: "#5fd68b", "accent-solid": "#5fd68b", "on-accent": "#1b1a18", "accent-soft": "#15301f" },
  },
  teal: {
    light: { accent: "#0f766e", "accent-solid": "#0f766e", "on-accent": "#ffffff", "accent-soft": "#e6f4f2" },
    dark: { accent: "#4fd1c5", "accent-solid": "#4fd1c5", "on-accent": "#1b1a18", "accent-soft": "#112f2c" },
  },
};

/** The choice's name in forms, and the key of the form that saves it. */
export const TINT_FIELD = "tint";

export function parseTint(value: unknown): Tint | null {
  return TINTS.includes(value as Tint) ? (value as Tint) : null;
}

/** A stored tint, or orange for none, or for anything else. */
export function storedTint(value: string | null | undefined): Tint {
  return parseTint(value) ?? DEFAULT_TINT;
}
