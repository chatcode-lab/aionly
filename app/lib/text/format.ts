/**
 * The formatting buttons' edits to the board's Markdown: each takes the text
 * and the selection, and gives back the new text and what to select. Inline
 * marks wrap the selection, or come off when it is already wrapped; line
 * marks apply to every line the selection touches, or come off when every
 * one already has them.
 */

export type Format = "bold" | "italic" | "strike" | "code" | "link" | "quote" | "list" | "numbered";

export interface Edit {
  text: string;
  start: number;
  end: number;
}

const LIST_MARK = /^(?:[-*+]|\d{1,9}[.)]) /;

const WRAP: Record<"bold" | "italic" | "strike" | "code", string> = {
  bold: "**",
  italic: "*",
  strike: "~~",
  code: "`",
};

/** What each format inserts on an empty selection, selected so typing replaces it. */
const PLACEHOLDER: Record<"bold" | "italic" | "strike" | "code" | "link", string> = {
  bold: "bold text",
  italic: "italic text",
  strike: "struck text",
  code: "code",
  link: "link text",
};

export function applyFormat(text: string, start: number, end: number, format: Format): Edit {
  if (start > end) [start, end] = [end, start];
  switch (format) {
    case "bold":
    case "italic":
    case "strike":
      return wrap(text, start, end, WRAP[format], PLACEHOLDER[format]);
    case "code":
      // Several lines become a code block; part of one, inline code.
      return text.slice(start, end).includes("\n") ? fence(text, start, end) : wrap(text, start, end, "`", PLACEHOLDER.code);
    case "link":
      return link(text, start, end);
    case "quote":
      return lines(text, start, end, () => "> ", /^> ?/);
    // Either list replaces the other's marks.
    case "list":
      return lines(text, start, end, () => "- ", /^[-*+] /, LIST_MARK);
    case "numbered":
      return lines(text, start, end, (index) => `${index + 1}. `, /^\d{1,9}[.)] /, LIST_MARK);
  }
}

function wrap(text: string, start: number, end: number, mark: string, placeholder: string): Edit {
  const selected = text.slice(start, end);
  // Already wrapped, inside or just outside the selection: take the marks off.
  if (
    selected.length >= mark.length * 2 &&
    selected.startsWith(mark) &&
    selected.endsWith(mark) &&
    !(mark === "*" && selected.startsWith("**") && !selected.startsWith("***"))
  ) {
    const inner = selected.slice(mark.length, selected.length - mark.length);
    return { text: text.slice(0, start) + inner + text.slice(end), start, end: start + inner.length };
  }
  const before = text.slice(Math.max(0, start - mark.length), start);
  const after = text.slice(end, end + mark.length);
  if (before === mark && after === mark && !(mark === "*" && text.slice(start - 2, start) === "**" && text.slice(start - 3, start) !== "***")) {
    return {
      text: text.slice(0, start - mark.length) + selected + text.slice(end + mark.length),
      start: start - mark.length,
      end: end - mark.length,
    };
  }
  // Marks hug the words: spaces at either end of the selection stay outside.
  const lead = selected.length - selected.trimStart().length;
  const trail = selected.length - selected.trimEnd().length;
  const core = selected.trim();
  const body = core || placeholder;
  const from = start + (core ? lead : 0);
  const to = end - (core ? trail : 0);
  return {
    text: text.slice(0, from) + mark + body + mark + text.slice(to),
    start: from + mark.length,
    end: from + mark.length + body.length,
  };
}

function link(text: string, start: number, end: number): Edit {
  const selected = text.slice(start, end).trim();
  if (/^https?:\/\/\S+$/.test(selected)) {
    // An address selected: it becomes the link, and its words are to be typed.
    const inserted = `[${PLACEHOLDER.link}](${selected})`;
    return { text: text.slice(0, start) + inserted + text.slice(end), start: start + 1, end: start + 1 + PLACEHOLDER.link.length };
  }
  const label = selected || PLACEHOLDER.link;
  const inserted = `[${label}](https://)`;
  // The address is what is left to type.
  const addressAt = start + label.length + 3;
  return { text: text.slice(0, start) + inserted + text.slice(end), start: addressAt, end: addressAt + "https://".length };
}

const OPENING_FENCE = /^```[\w+-]*\s*$/;
const CLOSING_FENCE = /^```\s*$/;

function fence(text: string, start: number, end: number): Edit {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the start of a line does not take that line in.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = text.indexOf("\n", last);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const chosen = text.slice(from, to).split("\n");
  // A whole block selected, fences and all: the fences come off.
  if (chosen.length >= 3 && OPENING_FENCE.test(chosen[0]!) && CLOSING_FENCE.test(chosen[chosen.length - 1]!)) {
    const inner = chosen.slice(1, -1).join("\n");
    return { text: text.slice(0, from) + inner + text.slice(to), start: from, end: from + inner.length };
  }
  // The inside of a block selected, as the button leaves it: so do its fences.
  if (from > 0 && to < text.length) {
    const aboveFrom = text.lastIndexOf("\n", from - 2) + 1;
    const belowEnd = text.indexOf("\n", to + 1);
    const above = text.slice(aboveFrom, from - 1);
    const below = text.slice(to + 1, belowEnd === -1 ? text.length : belowEnd);
    if (OPENING_FENCE.test(above) && CLOSING_FENCE.test(below)) {
      const inner = text.slice(from, to);
      const after = belowEnd === -1 ? text.length : belowEnd;
      return { text: text.slice(0, aboveFrom) + inner + text.slice(after), start: aboveFrom, end: aboveFrom + inner.length };
    }
  }
  const block = `\`\`\`\n${text.slice(from, to)}\n\`\`\``;
  return { text: text.slice(0, from) + block + text.slice(to), start: from + 4, end: from + block.length - 4 };
}

function lines(
  text: string,
  start: number,
  end: number,
  prefix: (index: number) => string,
  existing: RegExp,
  replaced: RegExp = existing,
): Edit {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  // A selection ending at the start of a line does not take that line in.
  const last = end > start && text[end - 1] === "\n" ? end - 1 : end;
  const lineEnd = text.indexOf("\n", last);
  const to = lineEnd === -1 ? text.length : lineEnd;
  const chosen = text.slice(from, to).split("\n");
  const marked = chosen.every((line) => existing.test(line));
  const changed = marked
    ? chosen.map((line) => line.replace(existing, ""))
    : chosen.map((line, index) => prefix(index) + line.replace(replaced, ""));
  const block = changed.join("\n");
  // A single empty line: the cursor goes after the new mark, to type there.
  if (!marked && chosen.length === 1 && chosen[0] === "") {
    return { text: text.slice(0, from) + block + text.slice(to), start: from + block.length, end: from + block.length };
  }
  return { text: text.slice(0, from) + block + text.slice(to), start: from, end: from + block.length };
}

/** Keyboard shortcuts for the buttons, with Ctrl or Cmd. */
export function shortcut(event: { key: string; metaKey: boolean; ctrlKey: boolean; shiftKey: boolean; altKey: boolean }): Format | null {
  if (!(event.metaKey || event.ctrlKey) || event.altKey) return null;
  const key = event.key.toLowerCase();
  if (event.shiftKey) return key === "x" ? "strike" : null;
  return key === "b" ? "bold" : key === "i" ? "italic" : key === "k" ? "link" : key === "e" ? "code" : null;
}
