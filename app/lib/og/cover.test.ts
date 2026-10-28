import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { coverSvg, drawable, type Fonts, HEIGHT, measure, WIDTH, wrap } from "./cover";
import { readFontMetrics } from "./metrics";
import type { Frame } from "./framing";
import { coverVersion } from "./version";

const WHOLE: Frame = { left: 0, top: 0, right: 1, bottom: 1 };

const font = (name: string) => {
  const bytes = readFileSync(new URL(`./fonts/${name}`, import.meta.url));
  return readFontMetrics(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
};
const fonts: Fonts = { regular: font("Inter-Regular.ttf.bin"), semibold: font("InterDisplay-SemiBold.ttf.bin") };

describe("font metrics", () => {
  it("read advances from the font file, and know which characters it lacks", () => {
    const m = fonts.regular.advance("m".codePointAt(0)!)!;
    const i = fonts.regular.advance("i".codePointAt(0)!)!;
    expect(m).toBeGreaterThan(i);
    expect(m).toBeGreaterThan(0.5);
    expect(m).toBeLessThan(1.2);
    expect(fonts.regular.advance("Ж".codePointAt(0)!)).not.toBeNull();
    expect(fonts.regular.advance("😀".codePointAt(0)!)).toBeNull();
    expect(fonts.regular.advance("中".codePointAt(0)!)).toBeNull();
  });
});

describe("text on covers", () => {
  it("drops what the fonts cannot draw, and collapses spaces", () => {
    expect(drawable("Made  with 😀 Suno\n中文 — ok", fonts.regular)).toBe("Made with Suno — ok");
  });

  it("wraps at spaces within the width, ending cut text with an ellipsis", () => {
    const text = "A song made with Suno about a lighthouse keeper who talks to the sea every night";
    const { lines, complete } = wrap(text, fonts.semibold, 64, 1056, 3);
    expect(complete).toBe(true);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line, fonts.semibold, 64)).toBeLessThanOrEqual(1056);
    expect(lines.join(" ")).toBe(text);

    const short = wrap(text, fonts.semibold, 64, 400, 2);
    expect(short.complete).toBe(false);
    expect(short.lines).toHaveLength(2);
    expect(short.lines[1]!.endsWith("…")).toBe(true);
    expect(measure(short.lines[1]!, fonts.semibold, 64)).toBeLessThanOrEqual(400);
  });

  it("cuts a word too long for a line", () => {
    const { lines } = wrap("https://example.com/a-very-long-address-with-no-spaces-at-all", fonts.regular, 40, 300, 4);
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(measure(line, fonts.regular, 40)).toBeLessThanOrEqual(300);
  });
});

describe("covers", () => {
  it("are 1200 by 630 with escaped text, for every kind", () => {
    const covers = [
      coverSvg({ kind: "site", tagline: "A place for <all> things AI", promise: "Open source" }, fonts),
      coverSvg({ kind: "page", title: "Rules", description: "What belongs & what does not", address: "aion.ly/rules" }, fonts),
      coverSvg({ kind: "post", title: 'A "song"', description: "Why it is good", byline: "Found by x · suno.com", picture: { href: "data:image/png;base64,AAAA", width: 4, height: 3, frame: WHOLE } }, fonts),
      coverSvg({ kind: "profile", name: "quiet_otter", subtitle: "On aion.ly since October 2026", address: "aion.ly/@quiet_otter", avatar: { color: "#2b6cb0", letter: "Q" } }, fonts),
    ];
    for (const svg of covers) {
      expect(svg).toContain(`width="${WIDTH}" height="${HEIGHT}"`);
      expect(svg).not.toMatch(/<all>|& what|"song"/);
    }
    expect(covers[0]).toContain("&lt;all&gt;");
    expect(covers[2]).toContain("&quot;song&quot;");
    expect(covers[2]).toContain('href="data:image/png;base64,AAAA"');
  });

  it("show a post's picture whole as far as its frame goes, in a card beside the title alone (owner's request, 2026-10-28)", () => {
    // A video thumbnail: 4:3, its middle 16:9 between black bars.
    const picture = { href: "data:image/jpeg;base64,AAAA", width: 480, height: 360, frame: { left: 0, top: 0.125, right: 1, bottom: 0.875 } };
    const svg = coverSvg({ kind: "post", title: "A song", description: "Why it is good", byline: "Found by x", picture }, fonts);
    // 520 by 292.5 at the right margin, centered between the top and bottom.
    expect(svg).toContain('<rect x="608" y="169" width="520" height="293" rx="16"/>');
    // The whole picture is placed so that its frame fills the card, and cut to it.
    expect(svg).toMatch(/<image x="608.00" y="120.\d+" width="520.00" height="390.\d+" preserveAspectRatio="none" clip-path="url\(#card\)"/);
    expect(svg).not.toContain("Why it is good");
    // A tall picture takes the margins' height, and narrows the text instead.
    const tall = coverSvg({ kind: "post", title: "A song", description: "", byline: "Found by x", picture: { ...picture, width: 360, height: 640, frame: WHOLE } }, fonts);
    expect(tall).toContain('<rect x="855" y="72" width="273" height="486" rx="16"/>');
  });

  it("run a post's byline under its picture when the picture ends above it, else beside it", () => {
    const byline = "Found by someone_with_a_long_name (agent) · example.com";
    const footer = (svg: string) => /font-size="28" fill="#6f6b64">([^<]*)<\/text>/.exec(svg)![1];
    const wide = { href: "data:image/png;base64,AAAA", width: 1600, height: 900, frame: WHOLE };
    expect(footer(coverSvg({ kind: "post", title: "A song", description: "", byline, picture: wide }, fonts))).toBe(byline);
    const square = { ...wide, width: 900 };
    expect(footer(coverSvg({ kind: "post", title: "A song", description: "", byline, picture: square }, fonts))).toMatch(/…$/);
  });

  it("never cut a description to a single line: whole, two lines or more, or none", () => {
    // A title that takes three lines leaves room for one line of description.
    const title = "A long title about agents that trade, scam and bargain inside an old online game, and what they learn";
    const shown = (description: string) => /font-size="30"/.test(coverSvg({ kind: "post", title, description, byline: "Posted by x" }, fonts));
    expect(shown("Short and whole.")).toBe(true);
    expect(shown("A description far too long for the one line left under a title of three lines, which would end in an ellipsis.")).toBe(false);
    expect(shown("")).toBe(false);
  });

  it("show the logo, the eyes above the wordmark, on every kind", () => {
    const covers = [
      coverSvg({ kind: "site", tagline: "A place", promise: "Open source" }, fonts),
      coverSvg({ kind: "page", title: "Rules", description: "What belongs", address: "aion.ly/rules" }, fonts),
      coverSvg({ kind: "post", title: "A song", description: "", byline: "Posted by x" }, fonts),
      coverSvg({ kind: "profile", name: "x", subtitle: "", address: "aion.ly/@x", avatar: { color: "#2b6cb0", letter: "X" } }, fonts),
    ];
    for (const svg of covers) {
      const eyes = /<g transform="translate\(72 72\) scale\(([\d.]+)\)"/.exec(svg);
      const name = /<text x="72" y="(\d+)" font-family="[^"]+" font-size="(\d+)"[^>]*><tspan fill="#c2410c">ai<\/tspan>on\.ly<\/text>/.exec(svg);
      expect(eyes).not.toBeNull();
      expect(name).not.toBeNull();
      // The eyes, half as tall as they are wide, end above the name's tallest letters.
      expect(72 + 24 * Number(eyes![1])).toBeLessThan(Number(name![1]) - 0.77 * Number(name![2]));
    }
  });

  it("give a post with nothing drawable a title anyway", () => {
    expect(coverSvg({ kind: "post", title: "😀😀😀", description: "", byline: "Posted by x" }, fonts)).toContain("A post on aion.ly");
  });

  it("have versions that change with what they show", () => {
    expect(coverVersion("a", "b")).toBe(coverVersion("a", "b"));
    expect(coverVersion("a", "b")).not.toBe(coverVersion("a", "c"));
    expect(coverVersion("ab", "")).not.toBe(coverVersion("a", "b"));
  });
});
