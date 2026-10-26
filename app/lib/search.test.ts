import { describe, expect, it } from "vitest";

import { MARK_END, MARK_START, markedPieces, matchExpression, QUERY_MAX, searchQuery, snippetOf } from "./search";

const mark = (word: string) => `${MARK_START}${word}${MARK_END}`;

describe("a search as typed", () => {
  it("is kept on one line, trimmed, and at most so long", () => {
    expect(searchQuery("  diffusion\n\tmodels  ")).toBe("diffusion models");
    expect(searchQuery(null)).toBe("");
    expect(searchQuery("x".repeat(QUERY_MAX + 50))).toHaveLength(QUERY_MAX);
  });
});

describe("a search as the index reads it", () => {
  it("quotes every word, so all must be there and nothing is read as syntax", () => {
    expect(matchExpression("Diffusion models")).toBe('"diffusion" "models"');
    expect(matchExpression("music OR NOT video*")).toBe('"music" "not" "video*"');
    expect(matchExpression("title:music NEAR(a b)")).toBe('"title:music" "near(a" "b)"');
  });

  it("keeps a quoted phrase whole, and an unclosed quote runs to the end", () => {
    expect(matchExpression('"big buck" bunny')).toBe('"big buck" "bunny"');
    expect(matchExpression('bunny "the source for')).toBe('"bunny" "the source for"');
  });

  it("leaves out words too common to narrow it, unless nothing else is asked", () => {
    expect(matchExpression("how to make music with AI")).toBe('"make" "music" "ai"');
    expect(matchExpression("what is it")).toBe('"what" "is" "it"');
    expect(matchExpression('"the source" of')).toBe('"the source"');
  });

  it("drops what has no letter or digit, and repeats, and looks for ten at most", () => {
    expect(matchExpression('— "" * Music music')).toBe('"music"');
    expect(matchExpression("   ")).toBeNull();
    expect(matchExpression('"" — ?')).toBeNull();
    const many = Array.from({ length: 14 }, (_, n) => `word${n}`).join(" ");
    expect(matchExpression(many)?.split(" ")).toHaveLength(10);
  });
});

describe("marked text", () => {
  it("comes in pieces, every other one a match", () => {
    expect(markedPieces(`${mark("Diffusion")} models ${mark("explained")}`)).toEqual(["", "Diffusion", " models ", "explained", ""]);
    expect(markedPieces("No match")).toEqual(["No match"]);
  });

  it("drops a stray mark", () => {
    expect(markedPieces(`One ${MARK_START}two`)).toEqual(["One two"]);
  });
});

describe("a snippet", () => {
  const words = (count: number, word = "word") => Array.from({ length: count }, () => word).join(" ");

  it("is the start of the text, on one line, when the match is near it or nowhere", () => {
    expect(snippetOf(`A ${mark("model")}\non two lines.`)).toBe(`A ${mark("model")} on two lines.`);
    expect(snippetOf(words(10))).toBe(words(10));
  });

  it("starts a little before a match further in, at a word", () => {
    const snippet = snippetOf(`${words(40)} ${mark("model")} ends here.`);
    expect(snippet.startsWith("…word ")).toBe(true);
    expect(snippet.endsWith(`${mark("model")} ends here.`)).toBe(true);
    expect(snippet.indexOf(MARK_START)).toBeLessThanOrEqual(65);
  });

  it("is cut at a word, never inside a match", () => {
    const snippet = snippetOf(`${mark("model")} ${words(100)}`);
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.slice(0, -1).split(" ").at(-1)).toBe("word");
    expect(snippet.length).toBeLessThanOrEqual(242);
    const long = snippetOf(`${words(47)} ${mark("x".repeat(30))} ${words(40)}`);
    expect(long.lastIndexOf(MARK_START)).toBeLessThan(long.lastIndexOf(MARK_END));
  });
});
