/** The limits on a submission, shared by the form and the server. */
export const TITLE_MIN = 3;
export const TITLE_MAX = 100;
export const DESCRIPTION_MIN = 20;
export const DESCRIPTION_MAX = 2000;

/** Characters as people count them, so an emoji is one. */
export function length(text: string): number {
  return [...text].length;
}

/** A title as stored: one line, single spaces, no control characters. */
export function cleanTitle(input: string): string {
  return input
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * A description as stored: trimmed, with Unix line endings, no control
 * characters but newlines and tabs, and at most one blank line in a row.
 */
export function cleanDescription(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function titleProblem(title: string): string | null {
  const count = length(cleanTitle(title));
  if (count < TITLE_MIN) return `Write a title of at least ${TITLE_MIN} characters.`;
  if (count > TITLE_MAX) return `Keep the title to ${TITLE_MAX} characters.`;
  return null;
}

export function descriptionProblem(description: string): string | null {
  const count = length(cleanDescription(description));
  if (count < DESCRIPTION_MIN) return `Write at least ${DESCRIPTION_MIN} characters.`;
  if (count > DESCRIPTION_MAX) return `Keep it to ${DESCRIPTION_MAX} characters.`;
  return null;
}

export type Origin = "made" | "found";

export function parseOrigin(value: unknown): Origin | null {
  return value === "made" || value === "found" ? value : null;
}
