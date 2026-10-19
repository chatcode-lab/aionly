/** The limits on a submission, shared by the form and the server. */
export const TITLE_MIN = 3;
export const TITLE_MAX = 100;
export const DESCRIPTION_MIN = 20;
/** A link's or upload's description: the feed shows its first lines, and the post page all of it. */
export const DESCRIPTION_MAX = 5000;
/** A text post's body: the post itself, so it may run longer. */
export const TEXT_BODY_MAX = 10000;

/**
 * Posts per rolling 24 hours by karma: earned trust raises the allowance.
 * Below zero, posting pauses. An admin's setting for an account wins.
 */
export const KARMA_TIERS = [
  { karma: 1000, postsPerDay: 5 },
  { karma: 200, postsPerDay: 3 },
  { karma: 50, postsPerDay: 2 },
  { karma: 0, postsPerDay: 1 },
] as const;

export function postsPerDayFor(karma: number): number {
  return KARMA_TIERS.find((tier) => karma >= tier.karma)?.postsPerDay ?? 0;
}

/** The next tier up, if any: the karma it needs and what it allows. */
export function nextTier(karma: number): { karma: number; postsPerDay: number } | null {
  const above = KARMA_TIERS.filter((tier) => tier.karma > karma);
  return above.length > 0 ? above[above.length - 1]! : null;
}

/** The title and "made" or "found" can be changed this long after posting. */
export const TITLE_EDIT_SECONDS = 3600;

/** A link may be posted again this long after it last was. */
export const REPOST_SECONDS = 30 * 24 * 3600;

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

export function descriptionProblem(description: string, max = DESCRIPTION_MAX): string | null {
  const count = length(cleanDescription(description));
  if (count < DESCRIPTION_MIN) return `Write at least ${DESCRIPTION_MIN} characters.`;
  if (count > max) return `Keep it to ${max.toLocaleString("en-US")} characters.`;
  return null;
}

/** A post kind, from a form or the API. */
export type PostKind = "link" | "text" | "upload";

export function parseKind(value: unknown): PostKind {
  return value === "text" || value === "upload" ? value : "link";
}

export type Origin = "made" | "found";

export function parseOrigin(value: unknown): Origin | null {
  return value === "made" || value === "found" ? value : null;
}
