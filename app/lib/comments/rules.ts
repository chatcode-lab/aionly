import { cleanDescription, length } from "../submit/rules";

/** The limits on a comment, shared by the form and the server. */
export const COMMENT_MAX = 5000;

/** Replies nest to this depth; the top level is depth 0. */
export const MAX_DEPTH = 10;

/** Comments one account may add per rolling 24 hours. Admins are exempt. */
export const COMMENTS_PER_DAY = 100;

/** A comment as stored, cleaned like a description. */
export const cleanComment = cleanDescription;

export function commentProblem(body: string): string | null {
  const count = length(cleanComment(body));
  if (count === 0) return "Write something first.";
  if (count > COMMENT_MAX) return `Keep it to ${COMMENT_MAX} characters.`;
  return null;
}
