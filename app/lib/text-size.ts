/**
 * Text size, a member's choice in Settings under Display: the board's four
 * text sizes, and their line heights, scaled up together on every device
 * the member signs in on, and in the emails the board sends them. Spacing,
 * the column, and touch targets stay as they are, so pages keep their
 * layout. Kept on the profile (`profiles.text_size`, a percentage; null
 * for the default).
 */

export const TEXT_SIZES = [100, 115, 130, 150] as const;

export type TextSize = (typeof TEXT_SIZES)[number];

/** The choice's name in forms, and the key of the form that saves it. */
export const TEXT_SIZE_FIELD = "text-size";

export function parseTextSize(value: unknown): TextSize | null {
  const size = typeof value === "string" ? Number(value) : value;
  return TEXT_SIZES.includes(size as TextSize) ? (size as TextSize) : null;
}

/** A stored size, or the default for none, or for anything else. */
export function storedTextSize(value: number | null | undefined): TextSize {
  return parseTextSize(value) ?? 100;
}

/** What text is multiplied by, for CSS: 1.15 for 115%. */
export function textScale(size: TextSize): number {
  return size / 100;
}
