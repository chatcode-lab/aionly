/**
 * The limited Markdown descriptions and comments may use: emphasis,
 * strikethrough, lists, quotes, and code, plus mentions. It parses to plain
 * data that is rendered as React elements, never as HTML, so markup in the
 * text is only ever text. Links, written `[label](url)` or bare, are kept as
 * links here; the renderer decides which may be followed. Images are links
 * to their address, never shown.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em" | "strike"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "break" }
  // A stored mention: `<@user-id>`.
  | { type: "mention"; id: string }
  // `[label](href)`, with the label parsed, or a bare address.
  | { type: "link"; href: string; children: Inline[] }
  | { type: "url"; href: string };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "quote"; children: Block[] }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] };

// Quotes inside quotes, and emphasis inside emphasis, stop here.
const MAX_NESTING = 3;

const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^ {0,3}[-*+][ \t]+(.*)$/;
const NUMBERED = /^ {0,3}(\d{1,9})[.)][ \t]+(.*)$/;
const LINK = /^\[([^\]\n]{0,500})\]\(([^()\s]{1,2048})(?:[ \t]+"[^"\n]{0,200}")?\)/;
const ESCAPABLE = /[\\`*_[\]()>#+\-.!~<@]/;
const MENTION_TOKEN = /^<@([A-Za-z0-9_-]{1,32})>/;
const BARE_URL = /^https?:\/\/[^\s<>"'`]+/;
const WORD = /[\p{L}\p{N}]/u;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function startsBlock(line: string): boolean {
  return FENCE.test(line) || QUOTE.test(line) || BULLET.test(line) || NUMBERED.test(line);
}

/** Lines joined with breaks, each parsed for inline markup. */
function lines(texts: string[]): Inline[] {
  return texts.flatMap((text, index) => [
    ...(index > 0 ? [{ type: "break" } as const] : []),
    ...parseInline(text.trim()),
  ]);
}

export function parseBlocks(source: string, nesting = 0): Block[] {
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
      blocks.push({ type: "quote", children: parseBlocks(body.join("\n"), nesting + 1) });
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
        } else if (!isBlank(current) && /^[ \t]/.test(current) && !startsBlock(current)) {
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
    while (index < input.length && !isBlank(input[index]!) && (paragraph.length === 0 || !startsBlock(input[index]!))) {
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
    }
  });
}

/** The text without its markup, on one line, for summaries and previews. */
export function plainText(source: string): string {
  return blockTexts(parseBlocks(source), " ").join(" ").replace(/\s+/g, " ").trim();
}

/**
 * The text without its markup, keeping its lines: each paragraph, list
 * item, and line break starts a new line, and blank lines go. For the
 * feed's excerpts, which read as the post was written.
 */
export function plainLines(source: string): string {
  return blockTexts(parseBlocks(source), "\n")
    .join("\n")
    .split("\n")
    .map((line) => line.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}
