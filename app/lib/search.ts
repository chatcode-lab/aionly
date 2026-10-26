/** The longest search kept, in characters; the rest is dropped. */
export const QUERY_MAX = 200;

/** The most words and phrases a search looks for. */
const TERMS_MAX = 10;

/** The most matches a search shows, best first. */
export const SEARCH_LIMIT = 50;

// Around each match the index finds; noncharacters, which no text holds.
export const MARK_START = "﷐";
export const MARK_END = "﷑";

// Words too common to narrow a search, left out unless nothing else is asked
// or they are inside quotes.
const COMMON = new Set([
  "a", "an", "and", "are", "as", "at", "be", "by", "for", "from", "how", "in",
  "is", "it", "of", "on", "or", "the", "this", "to", "what", "with",
]);

// A snippet's length, and how much of it comes before its first match.
const SNIPPET_LENGTH = 240;
const SNIPPET_LEAD = 60;

/** What a visitor typed, on one line and at most `QUERY_MAX` long. */
export function searchQuery(value: string | null): string {
  return (value ?? "").replace(/\s+/g, " ").trim().slice(0, QUERY_MAX);
}

/**
 * A search as the index reads it: every word, and every "quoted phrase", must
 * be in the post's title or description, in any order. Each is quoted, so
 * nothing typed is read as the index's own syntax. Null when nothing is left
 * to look for.
 */
export function matchExpression(query: string): string | null {
  const terms: { text: string; quoted: boolean }[] = [];
  for (const [, quoted, word] of query.matchAll(/"([^"]*)"?|([^\s"]+)/g)) {
    const text = (quoted ?? word ?? "").trim();
    if (/[\p{L}\p{N}]/u.test(text)) terms.push({ text, quoted: quoted !== undefined });
  }
  const narrowing = terms.filter((term) => term.quoted || !COMMON.has(term.text.toLowerCase()));
  const kept = [...new Set((narrowing.length > 0 ? narrowing : terms).map((term) => term.text.toLowerCase()))];
  return kept.length > 0
    ? kept.slice(0, TERMS_MAX).map((term) => `"${term.replaceAll('"', '""')}"`).join(" ")
    : null;
}

/**
 * Text with its matches marked, in pieces: every other one, from the second,
 * is a match.
 */
export function markedPieces(text: string): string[] {
  const pattern = new RegExp(`${MARK_START}([^${MARK_START}${MARK_END}]*)${MARK_END}`);
  return text.split(pattern).map((piece) => piece.replaceAll(MARK_START, "").replaceAll(MARK_END, ""));
}

/**
 * Up to a few lines of marked text around its first match, on one line, cut
 * at words and never inside a match; the start when nothing in it matched.
 */
export function snippetOf(marked: string): string {
  const flat = marked.replace(/\s+/g, " ").trim();
  const first = flat.indexOf(MARK_START);
  let start = 0;
  if (first > SNIPPET_LEAD) {
    const space = flat.indexOf(" ", first - SNIPPET_LEAD);
    start = space !== -1 && space < first ? space + 1 : first;
  }
  let end = Math.min(flat.length, start + SNIPPET_LENGTH);
  if (end < flat.length) {
    const space = flat.lastIndexOf(" ", end);
    if (space > start + SNIPPET_LENGTH / 2) end = space;
    const cut = flat.slice(start, end);
    const close = flat.indexOf(MARK_END, end);
    if (cut.lastIndexOf(MARK_START) > cut.lastIndexOf(MARK_END) && close !== -1) end = close + 1;
  }
  return `${start > 0 ? "…" : ""}${flat.slice(start, end).trim()}${end < flat.length ? "…" : ""}`;
}
