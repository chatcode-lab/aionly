/**
 * The limited Markdown descriptions and comments may use: emphasis, lists,
 * quotes, and code. It parses to plain data that is rendered as React
 * elements, never as HTML, so markup in the text is only ever text. Links
 * stay inert: `[label](url)` reads "label (url)", and images likewise.
 */

export type Inline =
  | { type: "text"; text: string }
  | { type: "strong" | "em"; children: Inline[] }
  | { type: "code"; text: string }
  | { type: "break" };

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
const ESCAPABLE = /[\\`*_[\]()>#+\-.!~]/;
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

    const image = char === "!" && source[index + 1] === "[";
    if (char === "[" || image) {
      const link = LINK.exec(source.slice(image ? index + 1 : index));
      if (link) {
        flush();
        out.push(...parseInline(link[1]!, nesting + 1));
        text = `${link[1] ? " " : ""}(${link[2]})`;
        index += link[0].length + (image ? 1 : 0);
        continue;
      }
    }

    if ((char === "*" || char === "_") && nesting < MAX_NESTING) {
      const delimiter = source[index + 1] === char ? char + char : char;
      if (!unclosed.has(delimiter) && canOpen(source, index, delimiter)) {
        const close = findClose(source, index + delimiter.length, delimiter);
        if (close === -1) {
          unclosed.add(delimiter);
        } else {
          flush();
          out.push({
            type: delimiter.length === 2 ? "strong" : "em",
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

function inlineText(nodes: Inline[]): string {
  return nodes
    .map((node) =>
      node.type === "text" || node.type === "code"
        ? node.text
        : node.type === "break"
          ? " "
          : inlineText(node.children),
    )
    .join("");
}

/** The text without its markup, on one line, for excerpts and summaries. */
export function plainText(source: string): string {
  const flatten = (blocks: Block[]): string[] =>
    blocks.flatMap((block) => {
      switch (block.type) {
        case "paragraph":
          return [inlineText(block.children)];
        case "code":
          return [block.text];
        case "quote":
          return flatten(block.children);
        case "list":
          return block.items.map(inlineText);
      }
    });
  return flatten(parseBlocks(source)).join(" ").replace(/\s+/g, " ").trim();
}
