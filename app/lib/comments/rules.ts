import type { CommentData } from "../public-types";
import { cleanDescription, length } from "../submit/rules";

/** The limits on a comment, shared by the form and the server. */
export const COMMENT_MAX = 5000;

/** Replies nest to this depth; the top level is depth 0. */
export const MAX_DEPTH = 10;

/**
 * The most comments a discussion holds, against runaway threads. Its page
 * shows them a page of top-level comments at a time.
 */
export const THREAD_MAX = 10_000;

// Comments one account may add per rolling 24 hours is a setting
// (comments_per_day; see app/lib/settings.ts). Admins are exempt.

/** A comment as stored, cleaned like a description. */
export const cleanComment = cleanDescription;

export function commentProblem(body: string): string | null {
  const count = length(cleanComment(body));
  if (count === 0) return "Write something first.";
  if (count > COMMENT_MAX) return `Keep it to ${COMMENT_MAX} characters.`;
  return null;
}

/**
 * How a discussion is read: oldest first, as it happened; best first, by
 * score; or newest first. Replies follow the same order under each comment.
 */
export type CommentOrder = "old" | "best" | "new";

export const COMMENT_ORDERS: ReadonlyArray<{ value: CommentOrder; label: string }> = [
  { value: "best", label: "Best" },
  { value: "old", label: "Oldest" },
  { value: "new", label: "Newest" },
];

/**
 * A discussion with `bestFirstFrom` comments or more (a setting) opens
 * best first, where the votes help most; a smaller one reads in order.
 */
export function defaultOrder(comments: number, bestFirstFrom: number): CommentOrder {
  return comments >= bestFirstFrom ? "best" : "old";
}

export function parseOrder(value: unknown): CommentOrder | null {
  return COMMENT_ORDERS.some((option) => option.value === value) ? (value as CommentOrder) : null;
}

/** Compares IDs as SQLite does, by code unit, so pages split where the database splits them. */
const byId = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

const COMPARE: Record<CommentOrder, (a: CommentData, b: CommentData) => number> = {
  old: (a, b) => a.createdAt - b.createdAt || byId(a.id, b.id),
  best: (a, b) => b.score - a.score || a.createdAt - b.createdAt || byId(a.id, b.id),
  new: (a, b) => b.createdAt - a.createdAt || byId(b.id, a.id),
};

/** Orders a reply tree in place, every level alike. */
export function orderThread(comments: CommentData[], order: CommentOrder): CommentData[] {
  comments.sort(COMPARE[order]);
  for (const comment of comments) orderThread(comment.replies, order);
  return comments;
}
