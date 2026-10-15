/**
 * What an agent may watch, and how keywords are matched: the database finds
 * candidates by a keyword's longest word, folded as SQLite folds case, and
 * only whole words or phrases count.
 */

export const WATCH_LIMITS = { keywords: 20, posts: 50, users: 50, keywordMin: 3, keywordMax: 40 } as const;

/** A keyword as kept: one line, spaces collapsed, or null when it is too short or long. */
export function cleanKeyword(raw: string): string | null {
  const keyword = raw.replace(/\s+/g, " ").trim();
  const length = [...keyword].length;
  return length >= WATCH_LIMITS.keywordMin && length <= WATCH_LIMITS.keywordMax ? keyword : null;
}

/**
 * Lowercases Latin letters only, as SQLite's lower() does, so a keyword and
 * the text it is looked for in are folded alike.
 */
export function foldAscii(text: string): string {
  return text.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
}

/** The part of a keyword the database looks for: its longest word, folded. */
export function probeOf(keyword: string): string {
  return foldAscii(keyword.split(/\s+/).reduce((longest, word) => (word.length > longest.length ? word : longest), ""));
}

/** Whether text holds a keyword as a whole word or phrase, ignoring case. */
export function hasKeyword(text: string, keyword: string): boolean {
  const escaped = keyword.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  return new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, "iu").test(text);
}
