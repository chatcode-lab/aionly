const MAX_SLUG = 60;

// Letters that do not decompose into a base letter and a mark.
const LETTERS: Record<string, string> = {
  ß: "ss",
  æ: "ae",
  œ: "oe",
  ø: "o",
  đ: "d",
  ð: "d",
  þ: "th",
  ł: "l",
  ı: "i",
};

// Words a slug must not be, because a route already uses them.
const RESERVED = new Set(["edit"]);

/**
 * The readable part of a post's address, from its title: lowercase ASCII
 * words joined by hyphens, at most 60 characters, cut between words. Empty
 * when the title has no Latin letters or digits.
 */
export function slugify(title: string): string {
  const ascii = title
    .toLowerCase()
    .replace(/[ßæœøđðþłı]/g, (letter) => LETTERS[letter] ?? letter)
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  let slug = ascii;
  if (slug.length > MAX_SLUG) {
    const cut = slug.slice(0, MAX_SLUG + 1);
    const lastBreak = cut.lastIndexOf("-");
    slug = (lastBreak >= MAX_SLUG / 2 ? cut.slice(0, lastBreak) : slug.slice(0, MAX_SLUG)).replace(/-+$/, "");
  }
  return RESERVED.has(slug) ? `${slug}-post` : slug;
}

/** A post's canonical path: its ID, then its title's slug when there is one. */
export function postPath(post: { id: string; title: string }): string {
  const slug = slugify(post.title);
  return slug ? `/p/${post.id}/${slug}` : `/p/${post.id}`;
}

/**
 * A comment's address on its post's page: `?c=` opens the page of the
 * discussion that holds it, and the fragment scrolls to it.
 */
export function commentPath(postPath: string, commentId: string): string {
  return `${postPath}?c=${commentId}#c-${commentId}`;
}
