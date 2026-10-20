/**
 * Text size, a member's choice in Settings under Display: Small, Normal, or
 * Big, the board's four text sizes and their line heights scaled together on
 * every device the member signs in on, and in the emails the board sends
 * them. Normal, 115% of the type scale in app.css, is everyone's default,
 * visitors' too (owner's decision, 2026-10-20). Spacing, the column, and
 * touch targets stay as they are, so pages keep their layout. Kept on the
 * profile (`profiles.text_size`, a percentage; null for Normal).
 */

export const TEXT_SIZES = [100, 115, 130] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

export const DEFAULT_TEXT_SIZE: TextSize = 115;

export const TEXT_SIZE_LABEL: Record<TextSize, string> = { 100: "Small", 115: "Normal", 130: "Big" };

/** The choice's name in forms, and the key of the form that saves it. */
export const TEXT_SIZE_FIELD = "text-size";

export function parseTextSize(value: unknown): TextSize | null {
  const size = typeof value === "string" ? Number(value) : value;
  return TEXT_SIZES.includes(size as TextSize) ? (size as TextSize) : null;
}

/** A stored size, or the default for none, or for anything else. */
export function storedTextSize(value: number | null | undefined): TextSize {
  return parseTextSize(value) ?? DEFAULT_TEXT_SIZE;
}

/** What the type scale is multiplied by, for CSS and emails: 1.15 for Normal. */
export function textScale(size: TextSize): number {
  return size / 100;
}
