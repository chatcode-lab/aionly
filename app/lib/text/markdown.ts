/**
 * The limited Markdown descriptions and comments may use: emphasis,
 * strikethrough, lists, quotes, and code, plus mentions. It parses to plain
 * data that is rendered as React elements, never as HTML, so markup in the
 * text is only ever text. Links, written `[label](url)` or bare, are kept as
 * links here; the renderer decides which may be followed. Images are links
 * to their address, never shown, except an article's own upload on a line
 * of its own, `![words](upload:<key>)` or `![words](upload:<key> "caption")`,
 * which is a block the renderer shows from the post's own files. Parsed as
 * an article's (`parseArticle`), a bare link to a provider's media on a
 * line of its own is a block too, which shows as its player.
 */

import { mediaUrl, resolveLink } from "../links/resolve";
import type { Aspect, Provider } from "../links/types";

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "strike"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "break" }
  // A stored mention: `<@user-id>`.
  | { type: "mention"; id: string }
  // `[label](href)`, with the label parsed, or a bare address.
  | { type: "link"; href: string; children: Inline[] }
  | { type: "url"; href: string }
  // An email address written in the text.
  | { type: "email"; address: string };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  // One of the post's own uploads, on a line of its own (see app/lib/article.ts).
  | { type: "media"; key: string; alt: string; caption: string | null }
  // In an article, a bare link to a provider's media on a line of its own: its
  // plain address, its `provider:id` key, and its place among the text's embeds.
  | { type: "embed"; url: string; key: string; provider: Provider; aspect: Aspect; index: number };

export type EmbedBlock = Extract<Block, { type: "embed" }>;

/** The most links an article's text shows as players; any after stay links (owner's request, 2026-10-26). */
export const TEXT_EMBEDS_MAX = 10;

/** How many links the text being parsed shows as players so far. */
interface EmbedBudget {
  used: number;
}

// Quotes inside quotes, and emphasis inside emphasis, stop here.
const MAX_NESTING = 3;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const LINK = /^\[([^\]\n]{0,500})\]\(([^()\s]{1,2048})(?:[ \t]+"[^"\n]{0,200}")?\)/;
/** An upload placed on a line of its own: its words, its key, and an optional caption. */
const MEDIA_LINE = /^ {0,3}!\[([^\]\n]{0,500})\]\(upload:([0-9A-Za-z]{24}\.[a-z0-9]{3,4})(?:[ \t]+"([^"\n]{0,200})")?\)[ \t]*$/;
const ESCAPABLE = /[\\`*_[\]()>#+\-.!~<@]/;
const MENTION_TOKEN = /^<@([A-Za-z0-9_-]{1,32})>/;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/;
/**
 * An email address, at most as long as one may be, an apostrophe within its
 * name included (O'Connor's); its domain ends in letters, so a full stop
 * after it stays out.
 */
const EMAIL = /^[A-Za-z0-9_%+-][A-Za-z0-9._%+'-]{0,63}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.[A-Za-z]{2,24}/;
const EMAIL_START = /[A-Za-z0-9_%+-]/;
/**
 * What an address can hold: its name's ASCII punctuation (RFC 5322's atext),
 * and, as an internationalized one may (RFC 6531), anything outside ASCII
 * but punctuation and spaces: letters of any script, combining marks,
 * numbers, symbols, and invisible joiners.
 */
const ADDRESS_CHAR = /[A-Za-z0-9!#$%&'*+/=?^_`{|}~.@-]|[^\0-\x7f\p{P}\p{Z}]/u;
/** What can carry a domain on: the same outside ASCII, as a domain's name may hold it. */
const DOMAIN_CHAR = /[A-Za-z0-9_@-]|[^\0-\x7f\p{P}\p{Z}]/u;

/** The address a `mailto:` link writes to, when it is one address and nothing more. */
export function mailtoAddress(href: string): string | null {
  const address = /^mailto:(.+)$/i.exec(href)?.[1];
  return address && EMAIL.exec(address)?.[0] === address ? address : null;
}
const WORD = /[\p{L}\p{N}]/u;

/*
 * An address is taken whole or not at all, so a link never names part of a
 * longer one, a different mailbox (review F104): nothing an address's name
 * can hold just before it, where a quotation mark opens it only when not
 * within a word; and nothing its domain can hold just after it, where a
 * full stop ends the sentence. Read by whole characters, a letter beyond
 * the first 65,536 included.
 */
const QUOTE_MARK = /['\p{Pi}\p{Pf}]/u;

/** The whole character that ends just before `index`, if any. */
function charBefore(source: string, index: number): string | undefined {
  if (index <= 0) return undefined;
  const pair = index >= 2 ? source.slice(index - 2, index) : "";
  return pair.length === 2 && pair.codePointAt(0)! > 0xffff ? pair : source[index - 1];
}

/** The whole character that starts at `index`, if any. */
function charAt(source: string, index: number): string | undefined {
  const code = source.codePointAt(index);
  return code === undefined ? undefined : String.fromCodePoint(code);
}

function opensAddress(source: string, index: number): boolean {
  const before = charBefore(source, index);
  if (before === undefined) return true;
  if (QUOTE_MARK.test(before)) {
    const outside = charBefore(source, index - before.length);
    return outside === undefined || !ADDRESS_CHAR.test(outside);
  }
  return !ADDRESS_CHAR.test(before);
}

function closesAddress(source: string, end: number): boolean {
  const after = charAt(source, source[end] === "." ? end + 1 : end);
  return after === undefined || !DOMAIN_CHAR.test(after);
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function startsBlock(line: string, embeds?: EmbedBudget): boolean {
  return (
    FENCE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    NUMBERED.test(line) ||
    MEDIA_LINE.test(line) ||
    (embeds !== undefined && embeds.used < TEXT_EMBEDS_MAX && embedOf(line) !== null)
  );
}

/**
 * A provider's media that a line holding nothing but its bare https address
 * links to, as an article shows it, or null: an address with words around
 * it, a short link the board would have to follow first, or a page that is
 * not one piece of media stays a link.
 */
export function embedOf(line: string): Omit<EmbedBlock, "index"> | null {
  const text = line.trim();
  if (!text.startsWith("https://") || bareUrl(text) !== text) return null;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return null;
  }
  const link = resolveLink(url);
  if (link.kind !== "media") return null;
  return { type: "embed", url: mediaUrl(link, url), key: link.canonicalKey, provider: link.provider, aspect: link.aspect };
}

/** Lines joined with breaks, each parsed for inline markup. */
function lines(texts: string[]): Inline[] {
  return texts.flatMap((text, index) => [
    ...(index > 0 ? [{ type: "break" } as const] : []),
    ...parseInline(text.trim()),
  ]);
}

/**
 * An article's text: as `parseBlocks`, but a bare link to a provider's media
 * on a line of its own, up to `TEXT_EMBEDS_MAX` of them, is an embed block.
 */
export function parseArticle(source: string): Block[] {
  return parseBlocks(source, 0, { used: 0 });
}

/** The links an article's text shows as players, in its order, quotes included. */
export function articleEmbeds(source: string): EmbedBlock[] {
  const found: EmbedBlock[] = [];
  const walk = (blocks: Block[]) => {
    for (const block of blocks) {
      if (block.type === "embed") found.push(block);
      else if (block.type === "quote") walk(block.children);
    }
  };
  walk(parseArticle(source));
  return found;
}

export function parseBlocks(source: string, nesting = 0, embeds?: EmbedBudget): Block[] {
  const input = source.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let index = 0;

  while (index < input.length) {
    const line = input[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < input.length && !input[index]!.trimStart().startsWith(marker)) {
        body.push(input[index]!);
        index += 1;
      }
      index += 1;
      blocks.push({ type: "code", text: body.join("\n") });
      continue;
    }

    if (QUOTE.test(line) && nesting < MAX_NESTING) {
      const body: string[] = [];
      let match: RegExpExecArray | null;
      while (index < input.length && (match = QUOTE.exec(input[index]!))) {
        body.push(match[1]!);
        index += 1;
      }
      blocks.push({ type: "quote", children: parseBlocks(body.join("\n"), nesting + 1, embeds) });
      continue;
    }

    const embed = embeds && embeds.used < TEXT_EMBEDS_MAX ? embedOf(line) : null;
    if (embed && embeds) {
      blocks.push({ ...embed, index: embeds.used });
      embeds.used += 1;
      index += 1;
      continue;
    }

    const media = MEDIA_LINE.exec(line);
    if (media) {
      blocks.push({ type: "media", key: media[2]!, alt: media[1]!.trim(), caption: media[3]?.trim() || null });
      index += 1;
      continue;
    }

    const bullet = BULLET.test(line);
    const numbered = NUMBERED.exec(line);
    if (bullet || numbered) {
      const pattern = bullet ? BULLET : NUMBERED;
      const items: string[][] = [];
      while (index < input.length) {
        const current = input[index]!;
        const item = pattern.exec(current);
        if (item) {
          items.push([item[bullet ? 1 : 2]!]);
        } else if (!isBlank(current) && /^[ \t]/.test(current) && !startsBlock(current, embeds)) {
          // An indented line continues the item above it.
          items[items.length - 1]!.push(current);
        } else {
          break;
        }
        index += 1;
      }
      blocks.push({
        type: "list",
        ordered: !bullet,
        start: numbered ? Number(numbered[1]) : 1,
        items: items.map(lines),
      });
      continue;
    }

    const paragraph: string[] = [];
    while (index < input.length && !isBlank(input[index]!) && (paragraph.length === 0 || !startsBlock(input[index]!, embeds))) {
      paragraph.push(input[index]!);
      index += 1;
    }
    blocks.push({ type: "paragraph", children: lines(paragraph) });
  }
  return blocks;
}

export function parseInline(source: string, nesting = 0): Inline[] {
  const out: Inline[] = [];
  let text = "";
  // Once a delimiter has no closing match, no later one will either.
  const unclosed = new Set<string>();
  const flush = () => {
    if (text) out.push({ type: "text", text });
    text = "";
  };

  let index = 0;
  while (index < source.length) {
    const char = source[index]!;

    if (char === "\\" && ESCAPABLE.test(source[index + 1] ?? "")) {
      text += source[index + 1];
      index += 2;
      continue;
    }

    if (char === "`") {
      let run = 1;
      while (source[index + run] === "`") run += 1;
      const fence = "`".repeat(run);
      const close = findCodeClose(source, index + run, fence);
      if (close === -1) {
        text += fence;
        index += run;
        continue;
      }
      let code = source.slice(index + run, close);
      if (code.length > 1 && code.startsWith(" ") && code.endsWith(" ")) code = code.slice(1, -1);
      flush();
      out.push({ type: "code", text: code });
      index = close + run;
      continue;
    }

    if (char === "<") {
      const mention = MENTION_TOKEN.exec(source.slice(index, index + 40));
      if (mention) {
        flush();
        out.push({ type: "mention", id: mention[1]! });
        index += mention[0].length;
        continue;
      }
    }

    const image = char === "!" && source[index + 1] === "[";
    if (char === "[" || image) {
      const link = LINK.exec(source.slice(image ? index + 1 : index));
      if (link) {
        flush();
        out.push({ type: "link", href: link[2]!, children: parseInline(link[1]!, nesting + 1) });
        index += link[0].length + (image ? 1 : 0);
        continue;
      }
    }

    if (char === "h" && (index === 0 || !WORD.test(source[index - 1]!))) {
      const url = bareUrl(source.slice(index, index + 2100));
      if (url) {
        flush();
        out.push({ type: "url", href: url });
        index += url.length;
        continue;
      }
    }

    // An email address, from where one could begin, and only a whole one.
    if (EMAIL_START.test(char) && opensAddress(source, index)) {
      const email = EMAIL.exec(source.slice(index, index + 320));
      if (email && closesAddress(source, index + email[0].length)) {
        flush();
        out.push({ type: "email", address: email[0] });
        index += email[0].length;
        continue;
      }
    }

    const strike = char === "~" && source[index + 1] === "~";
    if ((char === "*" || char === "_" || strike) && nesting < MAX_NESTING) {
      const delimiter = source[index + 1] === char ? char + char : char;
      if (!unclosed.has(delimiter) && canOpen(source, index, delimiter)) {
        const close = findClose(source, index + delimiter.length, delimiter);
        if (close === -1) {
          unclosed.add(delimiter);
        } else {
          flush();
          out.push({
            type: strike ? "strike" : delimiter.length === 2 ? "strong" : "em",
            children: parseInline(source.slice(index + delimiter.length, close), nesting + 1),
          });
          index = close + delimiter.length;
          continue;
        }
      }
      text += delimiter;
      index += delimiter.length;
      continue;
    }

    text += char;
    index += 1;
  }
  flush();
  return out;
}

/**
 * A bare address at the start of the text, without the punctuation that
 * usually follows one in a sentence. A closing parenthesis stays when the
 * address opened one, as Wikipedia's often do.
 */
function bareUrl(text: string): string | null {
  let url = BARE_URL.exec(text)?.[0];
  if (!url) return null;
  for (;;) {
    const last = url.at(-1)!;
    if (".,;:!?'\"".includes(last)) url = url.slice(0, -1);
    else if (last === ")" && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) url = url.slice(0, -1);
    else break;
  }
  return /^https?:\/\/[^/?#]+\.[^/?#]+/.test(url) ? url : null;
}

function findCodeClose(source: string, from: number, fence: string): number {
  let at = source.indexOf(fence, from);
  while (at !== -1) {
    // A longer run of backticks is not the closing one.
    if (source[at + fence.length] !== "`" && source[at - 1] !== "`") return at;
    at = source.indexOf(fence, at + 1);
  }
  return -1;
}

/**
 * An opening delimiter is followed by text, and an underscore one also
 * starts a word, so names like `quiet_otter_482` stay as they are.
 */
function canOpen(source: string, at: number, delimiter: string): boolean {
  const next = source[at + delimiter.length];
  if (next === undefined || /\s/.test(next)) return false;
  return delimiter[0] !== "_" || at === 0 || !WORD.test(source[at - 1]!);
}

function findClose(source: string, from: number, delimiter: string): number {
  const char = delimiter[0]!;
  for (let at = from + 1; at <= source.length - delimiter.length; at += 1) {
    if (!source.startsWith(delimiter, at)) continue;
    if (/\s/.test(source[at - 1]!)) continue;
    const after = source[at + delimiter.length];
    // A single delimiter is not half of a double one.
    if (delimiter.length === 1 && (after === char || source[at - 1] === char)) continue;
    if (char === "_" && after !== undefined && WORD.test(after)) continue;
    return at;
  }
  return -1;
}

function inlineText(nodes: Inline[], lineBreak = " "): string {
  return nodes
    .map((node) => {
      switch (node.type) {
        case "text":
        case "code":
          return node.text;
        case "break":
          return lineBreak;
        // Kept as a token; listings write in the current name.
        case "mention":
          return `<@${node.id}>`;
        case "url":
          return node.href;
        case "email":
          return node.address;
        case "link": {
          const label = inlineText(node.children, lineBreak);
          return label && label !== node.href ? `${label} (${node.href})` : node.href;
        }
        default:
          return inlineText(node.children, lineBreak);
      }
    })
    .join("");
}

/** Each block's text without its markup, its line breaks kept as `lineBreak`. */
function blockTexts(blocks: Block[], lineBreak: string): string[] {
  return blocks.flatMap((block) => {
    switch (block.type) {
      case "paragraph":
        return [inlineText(block.children, lineBreak)];
      case "code":
        return [block.text];
      case "quote":
        return blockTexts(block.children, lineBreak);
      case "list":
        return block.items.map((item) => inlineText(item, lineBreak));
      // A picture or player has no words in a summary.
      case "media":
      case "embed":
        return [];
    }
  });
}

/** The addresses a text links to, written as links or bare, in the order they come. */
export function linkAddresses(source: string): string[] {
  const inlines = (nodes: Inline[]): string[] =>
    nodes.flatMap((node) =>
      node.type === "link" || node.type === "url" ? [node.href] : "children" in node ? inlines(node.children) : [],
    );
  const blocks = (list: Block[]): string[] =>
    list.flatMap((block) =>
      block.type === "paragraph"
        ? inlines(block.children)
        : block.type === "quote"
          ? blocks(block.children)
          : block.type === "list"
            ? block.items.flatMap(inlines)
            : [],
    );
  return blocks(parseBlocks(source));
}

/** The text without its markup, on one line, for summaries and previews. */
export function plainText(source: string): string {
  return blockTexts(parseBlocks(source), " ").join(" ").replace(/\s+/g, " ").trim();
}

/** An article's text, its players left out, as `plainLines`. */
export function articleLines(source: string): string {
  return linesOf(parseArticle(source));
}

/**
 * The text without its markup, keeping its lines: each paragraph, list
 * item, and line break starts a new line, and blank lines go. For the
 * feed's excerpts, which read as the post was written.
 */
export function plainLines(source: string): string {
  return linesOf(parseBlocks(source));
}

function linesOf(blocks: Block[]): string {
  return blockTexts(blocks, "\n")
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
