/**
 * Markdown from the board's own simple pages, the rules, terms, and privacy
 * notice: their `<main>` as the server rendered it, with headings,
 * paragraphs, lists, links, and emphasis kept, and anything else (forms,
 * buttons, icons) reduced to its text. It reads only markup the board
 * writes, never anyone else's.
 */

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ldquo: "\u201c",
  rdquo: "\u201d",
  lsquo: "\u2018",
  rsquo: "\u2019",
  mdash: "\u2014",
  ndash: "\u2013",
  hellip: "\u2026",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith("#x") || name.startsWith("#X")) return String.fromCodePoint(Number.parseInt(name.slice(2), 16));
    if (name.startsWith("#")) return String.fromCodePoint(Number(name.slice(1)));
    return ENTITIES[name.toLowerCase()] ?? entity;
  });
}

/** The page's `<main>`, or the whole document when it has none. */
export function mainOf(html: string): string {
  const start = html.search(/<main[\s>]/);
  const end = html.lastIndexOf("</main>");
  return start >= 0 && end > start ? html.slice(start, end + "</main>".length) : html;
}

export function htmlToMarkdown(html: string, origin: string): string {
  let text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|svg|form|button|select|template)[\s\S]*?<\/\1>/gi, "");

  // Inline marks first, then blocks.
  text = text
    .replace(/<a\s[^>]*?href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, (_match, href: string, label: string) => {
      const target = decode(href);
      const absolute = target.startsWith("/") ? `${origin}${target}` : target;
      const words = label.replace(/<[^>]+>/g, "").trim();
      return target.startsWith("mailto:") ? words : `[${words}](${absolute})`;
    })
    .replace(/<(strong|b)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, "**$3**")
    .replace(/<(em|i)(\s[^>]*)?>([\s\S]*?)<\/\1>/gi, "*$3*")
    .replace(/<code(\s[^>]*)?>([\s\S]*?)<\/code>/gi, "`$2`")
    .replace(/<br\s*\/?>/gi, "\n");

  text = text
    .replace(/<h1(\s[^>]*)?>([\s\S]*?)<\/h1>/gi, "\n\n# $2\n\n")
    .replace(/<h2(\s[^>]*)?>([\s\S]*?)<\/h2>/gi, "\n\n## $2\n\n")
    .replace(/<h3(\s[^>]*)?>([\s\S]*?)<\/h3>/gi, "\n\n### $2\n\n")
    .replace(/<li(\s[^>]*)?>([\s\S]*?)<\/li>/gi, (_match, _attributes, item: string) => `\n- ${item.replace(/\s+/g, " ").trim()}`)
    .replace(/<\/?(ul|ol)(\s[^>]*)?>/gi, "\n")
    .replace(/<blockquote(\s[^>]*)?>([\s\S]*?)<\/blockquote>/gi, (_match, _attributes, quote: string) => `\n\n> ${quote.trim()}\n\n`)
    .replace(/<p(\s[^>]*)?>([\s\S]*?)<\/p>/gi, (_match, _attributes, paragraph: string) => `\n\n${paragraph.replace(/\s+/g, " ").trim()}\n\n`)
    .replace(/<[^>]+>/g, "");

  return `${decode(text)
    .split("\n")
    .map((line) => line.replace(/[ \t]+/g, " ").trimEnd())
    .join("\n")
    .replace(/^ +/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim()}\n`;
}
