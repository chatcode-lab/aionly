import { describe, expect, it } from "vitest";

import { applyFormat, type Format, shortcut } from "./format";
import { parseBlocks } from "./markdown";

/** Applies a format to text with the selection written as [ and ]. */
function format(marked: string, kind: Format): string {
  const start = marked.indexOf("[");
  const end = marked.indexOf("]") - 1;
  const text = marked.replace("[", "").replace("]", "");
  const edit = applyFormat(text, start, end, kind);
  return `${edit.text.slice(0, edit.start)}[${edit.text.slice(edit.start, edit.end)}]${edit.text.slice(edit.end)}`;
}

describe("formatting buttons", () => {
  it("wrap the selection in inline marks, keeping spaces outside", () => {
    expect(format("a [word ]here", "bold")).toBe("a **[word]** here");
    expect(format("a [word] here", "italic")).toBe("a *[word]* here");
    expect(format("a [word] here", "strike")).toBe("a ~~[word]~~ here");
    expect(format("run [npm test] now", "code")).toBe("run `[npm test]` now");
  });

  it("insert a placeholder to type over when nothing is selected", () => {
    expect(format("say []", "bold")).toBe("say **[bold text]**");
  });

  it("take marks off when pressed again, inside or around the selection", () => {
    expect(format("a **[word]** here", "bold")).toBe("a [word] here");
    expect(format("a [**word**] here", "bold")).toBe("a [word] here");
    expect(format("a *[word]* here", "italic")).toBe("a [word] here");
    // Italic inside bold is not bold's marks.
    expect(format("a **[word]** here", "italic")).toBe("a ***[word]*** here");
  });

  it("make a link, with the address or its words left to type", () => {
    expect(format("see [the paper]", "link")).toBe("see [the paper]([https://])");
    expect(format("see [https://arxiv.org/abs/1]", "link")).toBe("see [[link text]](https://arxiv.org/abs/1)");
  });

  it("mark every line the selection touches, and unmark them all together", () => {
    expect(format("one\n[two\nthree]", "quote")).toBe("one\n[> two\n> three]");
    expect(format("[> two\n> three]", "quote")).toBe("[two\nthree]");
    expect(format("a[b\nc]d", "list")).toBe("[- ab\n- cd]");
    expect(format("[x\ny\nz]", "numbered")).toBe("[1. x\n2. y\n3. z]");
    expect(format("[- x\ny]", "numbered")).toBe("[1. x\n2. y]");
    expect(format("text\n[]", "list")).toBe("text\n- []");
  });

  it("turn several lines into a code block", () => {
    expect(format("[let a = 1\nlet b = 2]", "code")).toBe("```\n[let a = 1\nlet b = 2]\n```");
  });

  it("take a code block's fences off when pressed again, with the selection it left or the whole block", () => {
    const once = applyFormat("say\nalpha\nbeta\nend", 4, 14, "code");
    expect(once.text).toBe("say\n```\nalpha\nbeta\n```\nend");
    const twice = applyFormat(once.text, once.start, once.end, "code");
    expect(twice).toEqual({ text: "say\nalpha\nbeta\nend", start: 4, end: 14 });
    expect(format("[```ts\nlet a = 1\nlet b = 2\n```]", "code")).toBe("[let a = 1\nlet b = 2]");
    // Lines that only look like a block's inside, with no fences around them, get fences.
    expect(format("```\nx\n```\n[a\nb]", "code")).toBe("```\nx\n```\n```\n[a\nb]\n```");
  });

  it("produce what the board's Markdown reads", () => {
    const bold = applyFormat("word", 0, 4, "bold").text;
    expect(parseBlocks(bold)).toEqual([{ type: "paragraph", children: [{ type: "strong", children: [{ type: "text", text: "word" }] }] }]);
    const list = applyFormat("x\ny", 0, 3, "numbered").text;
    expect(parseBlocks(list)[0]).toMatchObject({ type: "list", ordered: true, start: 1 });
    const quote = applyFormat("said", 0, 4, "quote").text;
    expect(parseBlocks(quote)[0]).toMatchObject({ type: "quote" });
  });

  it("answer to the usual shortcuts", () => {
    const keys = { metaKey: false, ctrlKey: true, shiftKey: false, altKey: false };
    expect(shortcut({ ...keys, key: "b" })).toBe("bold");
    expect(shortcut({ ...keys, key: "i" })).toBe("italic");
    expect(shortcut({ ...keys, key: "k" })).toBe("link");
    expect(shortcut({ ...keys, key: "X", shiftKey: true })).toBe("strike");
    expect(shortcut({ ...keys, ctrlKey: false, key: "b" })).toBeNull();
  });
});
