import { describe, expect, it } from "vitest";

import { mailtoAddress, parseBlocks, parseInline, plainLines, plainText } from "./markdown";

describe("parseInline", () => {
  it("reads emphasis, strong text, and code", () => {
    expect(parseInline("a *b* **c** `d`")).toEqual([
      { type: "text", text: "a " },
      { type: "em", children: [{ type: "text", text: "b" }] },
      { type: "text", text: " " },
      { type: "strong", children: [{ type: "text", text: "c" }] },
      { type: "text", text: " " },
      { type: "code", text: "d" },
    ]);
    expect(parseInline("*a **b** c*")).toEqual([
      {
        type: "em",
        children: [
          { type: "text", text: "a " },
          { type: "strong", children: [{ type: "text", text: "b" }] },
          { type: "text", text: " c" },
        ],
      },
    ]);
  });

  it("leaves names with underscores and lone asterisks alone", () => {
    expect(parseInline("ask quiet_otter_482 or snake_case_name")).toEqual([
      { type: "text", text: "ask quiet_otter_482 or snake_case_name" },
    ]);
    expect(parseInline("2 * 3 * 4 and *unclosed")).toEqual([
      { type: "text", text: "2 * 3 * 4 and *unclosed" },
    ]);
    expect(parseInline("_whole words_")).toEqual([
      { type: "em", children: [{ type: "text", text: "whole words" }] },
    ]);
  });

  it("keeps links and images as inert text", () => {
    expect(plainText("see [the paper](https://arxiv.org/abs/1706.03762) now")).toBe(
      "see the paper (https://arxiv.org/abs/1706.03762) now",
    );
    expect(plainText("![a cat](https://example.com/cat.png)")).toBe("a cat (https://example.com/cat.png)");
    expect(parseInline("[x](javascript:alert(1))").every((node) => node.type === "text")).toBe(true);
  });

  it("reads strikethrough, but not a single tilde", () => {
    expect(parseInline("~~old~~ new ~1 km")).toEqual([
      { type: "strike", children: [{ type: "text", text: "old" }] },
      { type: "text", text: " new ~1 km" },
    ]);
  });

  it("reads stored mentions", () => {
    expect(parseInline("thanks <@u_01> and <@x>!")).toEqual([
      { type: "text", text: "thanks " },
      { type: "mention", id: "u_01" },
      { type: "text", text: " and " },
      { type: "mention", id: "x" },
      { type: "text", text: "!" },
    ]);
    expect(plainText("hi <@u_01>")).toBe("hi <@u_01>");
  });

  it("finds bare addresses without the punctuation after them", () => {
    expect(parseInline("see https://example.com/a_b_c, then (https://en.wikipedia.org/wiki/Mars_(planet)).")).toEqual([
      { type: "text", text: "see " },
      { type: "url", href: "https://example.com/a_b_c" },
      { type: "text", text: ", then (" },
      { type: "url", href: "https://en.wikipedia.org/wiki/Mars_(planet)" },
      { type: "text", text: ")." },
    ]);
    expect(parseInline("xhttps://example.com and https://localhost")).toEqual([
      { type: "text", text: "xhttps://example.com and https://localhost" },
    ]);
  });

  it("keeps a written link's label and address apart", () => {
    expect(parseInline("[**the** post](https://aion.ly/p/abc1234)")).toEqual([
      {
        type: "link",
        href: "https://aion.ly/p/abc1234",
        children: [{ type: "strong", children: [{ type: "text", text: "the" }] }, { type: "text", text: " post" }],
      },
    ]);
  });

  it("keeps markup inside code, and backslash escapes", () => {
    expect(parseInline("`*not em*` \\*literal\\*")).toEqual([
      { type: "code", text: "*not em*" },
      { type: "text", text: " *literal*" },
    ]);
    expect(parseInline("``a ` b``")).toEqual([{ type: "code", text: "a ` b" }]);
  });

  it("treats HTML as text", () => {
    expect(parseInline("<script>alert(1)</script> <b>hi</b>")).toEqual([
      { type: "text", text: "<script>alert(1)</script> <b>hi</b>" },
    ]);
  });

  it("stays fast on text with many unclosed delimiters", () => {
    const start = performance.now();
    parseInline("*a _b **c ".repeat(500));
    expect(performance.now() - start).toBeLessThan(200);
  });
});

describe("email addresses", () => {
  it("are found in running text, a sentence's full stop left out", () => {
    expect(parseInline("Write to jane.doe+board@mail.example.org.")).toEqual([
      { type: "text", text: "Write to " },
      { type: "email", address: "jane.doe+board@mail.example.org" },
      { type: "text", text: "." },
    ]);
  });

  it("are not found in a web address, a mention, or a half-written one", () => {
    expect(parseInline("https://example.com/a@b.co")).toEqual([{ type: "url", href: "https://example.com/a@b.co" }]);
    expect(parseInline("ask @someone or name@host")).toEqual([{ type: "text", text: "ask @someone or name@host" }]);
  });

  it("are taken whole or not at all, never the end of a longer one (review F104)", () => {
    const address = (text: string) => parseInline(text).flatMap((node) => (node.type === "email" ? [node.address] : []));
    expect(address("Mail o'connor@example.org today")).toEqual(["o'connor@example.org"]);
    expect(address("Mail 'jane@example.org' or \u2018jane@example.org\u2019.")).toEqual(["jane@example.org", "jane@example.org"]);
    expect(address("jane@example.org's inbox, (jane@example.org), <jane@example.org>")).toEqual(Array(3).fill("jane@example.org"));
    // Valid, but beyond what is linked: left as written.
    for (const text of ["team!alerts@example.org", "a&b@example.org", "O\u2019Connor@example.org", "andr\u00e9alice@example.org", "x=jane@example.org", "jane@example.org@else.org", "jane@example.orgx\u00e9", "jane@example.org.x"]) {
      expect(parseInline(text), text).toEqual([{ type: "text", text }]);
    }
    expect(mailtoAddress("mailto:o'connor@example.org")).toBe("o'connor@example.org");
  });

  it("are read by whole characters, so an internationalized address is never cut to its ASCII end (review F104)", () => {
    // A letter beyond the first 65,536, a decomposed accent, a joiner, a symbol, letters of another script.
    for (const text of ["\u{1d49c}alice@example.org", "andre\u0301alice@example.org", "a\u200dalice@example.org", "\u{1f600}alice@example.org", "\u90ae\u4ef6alice@example.org", "jane@example.org\u0301", "jane@example.org\u{1d49c}", "jane@example.org.\u00e9"]) {
      expect(parseInline(text), text).toEqual([{ type: "text", text }]);
    }
    // Punctuation and spaces of any script still set an address apart.
    const address = (text: string) => parseInline(text).flatMap((node) => (node.type === "email" ? [node.address] : []));
    for (const text of ["\u201cjane@example.org\u201d", "\u00abjane@example.org\u00bb", "\u8054\u7cfb\uff1ajane@example.org\u3002", "Contact\u2014jane@example.org", "\u00a0jane@example.org"]) {
      expect(address(text), text).toEqual(["jane@example.org"]);
    }
  });

  it("read as themselves in plain text, and a mailto link names one address alone", () => {
    expect(plainText("Mail jane@example.org")).toBe("Mail jane@example.org");
    expect(mailtoAddress("mailto:jane@example.org")).toBe("jane@example.org");
    expect(mailtoAddress("MAILTO:jane@example.org")).toBe("jane@example.org");
    expect(mailtoAddress("mailto:jane@example.org?subject=Hi")).toBeNull();
    expect(mailtoAddress("mailto:a@b.org,c@d.org")).toBeNull();
    expect(mailtoAddress("https://example.org")).toBeNull();
  });
});

describe("parseBlocks", () => {
  it("reads paragraphs with line breaks, lists, quotes, and code blocks", () => {
    const blocks = parseBlocks(
      [
        "First line",
        "second line",
        "",
        "- one",
        "- two",
        "  continued",
        "",
        "3. three",
        "4. four",
        "",
        "> quoted *text*",
        "",
        "```js",
        "const a = 1 * 2;",
        "",
        "**not bold**",
        "```",
      ].join("\n"),
    );
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "list", "list", "quote", "code"]);
    expect(blocks[0]).toEqual({
      type: "paragraph",
      children: [{ type: "text", text: "First line" }, { type: "break" }, { type: "text", text: "second line" }],
    });
    expect(blocks[1]).toMatchObject({ ordered: false, items: [[{ text: "one" }], [{ text: "two" }, { type: "break" }, { text: "continued" }]] });
    expect(blocks[2]).toMatchObject({ ordered: true, start: 3 });
    expect(blocks[4]).toEqual({ type: "code", text: "const a = 1 * 2;\n\n**not bold**" });
  });

  it("ends a code block at the end of the text when it is never closed", () => {
    expect(parseBlocks("```\ncode")).toEqual([{ type: "code", text: "code" }]);
  });

  it("bounds nested quotes", () => {
    const blocks = parseBlocks("> > > > > deep");
    let depth = 0;
    let current = blocks[0];
    while (current?.type === "quote") {
      depth += 1;
      current = current.children[0];
    }
    expect(depth).toBe(3);
    expect(current).toMatchObject({ type: "paragraph" });
  });
});

describe("plainText", () => {
  it("drops markup and joins everything on one line", () => {
    expect(plainText("**Bold** and _em_\n\n- a\n- b\n\n> quote")).toBe("Bold and em a b quote");
  });
});

describe("plainLines", () => {
  it("drops markup and keeps the lines, without blank ones", () => {
    expect(plainLines("What the heck is\nWhat the heck is")).toBe("What the heck is\nWhat the heck is");
    expect(plainLines("**Bold**   and _em_\n\n\n- a\n- b\n\n> quote\n> more")).toBe("Bold and em\na\nb\nquote\nmore");
  });
});
