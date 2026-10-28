import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { coverSvg, drawable, type Fonts, HEIGHT, measure, WIDTH, wrap } from "./cover";
import { readFontMetrics } from "./metrics";
import { coverVersion } from "./version";

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
      coverSvg({ kind: "post", title: 'A "song"', description: "Why it is good", byline: "Found by x · suno.com", picture: { href: "data:image/png;base64,AAAA" } }, fonts),
      coverSvg({ kind: "profile", name: "quiet_otter", subtitle: "On aion.ly since October 2026", address: "aion.ly/@quiet_otter", avatar: { color: "#2b6cb0", letter: "Q" } }, fonts),
    ];
    for (const svg of covers) {
      expect(svg).toContain(`width="${WIDTH}" height="${HEIGHT}"`);
      expect(svg).not.toMatch(/<all>|& what|"song"/);
    }
    expect(covers[0]).toContain("&lt;all&gt;");
    expect(covers[2]).toContain("&quot;song&quot;");
    expect(covers[2]).toContain('preserveAspectRatio="xMidYMid slice"');
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
