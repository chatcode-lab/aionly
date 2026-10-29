import { describe, expect, it } from "vitest";

import { atTint, composeLetter } from "./layout";

describe("the email layout", () => {
  const letter = {
    subject: "Sign in to aion.ly",
    preview: "",
    heading: "The past month on aion.ly",
    paragraphs: ["Hi, I'm Boris, and I started aion.ly: a <board>.", "Write to hey@aion.ly or open aion.ly/join/boris, or aion.lyrics."],
    after: ["Not you? aion.ly sent it anyway."],
    why: "You get this as a member of aion.ly.",
    origin: "https://staging.example",
  };

  it("makes the board's name its own link in the text's color, so mail apps do not link and color it", () => {
    const { html, text } = composeLetter(letter);
    const named = (color: string) => `<a href="https://staging.example" style="color:${color};text-decoration:none" class="dc-${color.slice(1)}">aion.ly</a>`;
    expect(html).toContain(`The past month on ${named("#1f1d1a")}</div>`);
    expect(html).toContain(`I started ${named("#55524c")}: a &#60;board&#62;.`);
    expect(html).toContain(`Not you? ${named("#6f6b64")} sent it anyway.`);
    expect(html).toContain(`a member of ${named("#6f6b64")}.`);
    // An address, or a longer name, stays as it is.
    expect(html).toContain("Write to hey@aion.ly or open aion.ly/join/boris, or aion.lyrics.");
    expect(html).toContain("<title>Sign in to aion.ly</title>");
    expect(text).toContain("The past month on aion.ly\n");
    expect(text).not.toContain("<a ");
  });

  it("centers its button (owner's request, 2026-10-29)", () => {
    const { html } = composeLetter({ ...letter, button: { label: "Open aion.ly", url: "https://staging.example" } });
    expect(html).toContain('<tr><td align="center" style="padding:18px 0 0;text-align:center"><a href="https://staging.example" style="display:inline-block;background:#c2410c');
  });

  it("spans a phone's screen edge to edge, the card's own classes kept beside the dark scheme's, in any tint (owner's request, 2026-10-29)", () => {
    const { html } = composeLetter(letter);
    expect(html).toContain("@media (max-width:560px){.edge{padding-left:0!important;padding-right:0!important}.sheet{border-radius:0!important;");
    expect(html).toContain('<td align="center" class="edge" style="padding:24px 16px">');
    // The page around the card takes its color, light and dark, over the dark scheme's own rule.
    expect(html).toContain("body.page,table.page{background-color:#ffffff!important}");
    expect(html).toMatch(/and \(prefers-color-scheme:dark\)\{body\.page,table\.page\{background-color:#[0-9a-f]{6}!important\}/);
    expect(html).toContain('<body style="margin:0;background:#f7f6f3" class="page db-f7f6f3">');
    // In Apple Mail on a phone, which sets the email in as far as its subject, the text starts there.
    expect(html).toContain("<style>@supports (-webkit-touch-callout:none){@media (max-width:560px){.sheet{padding-left:0!important;padding-right:0!important}}}</style>");
    expect(html).toMatch(/<table [^>]*style="max-width:560px;background:#ffffff;[^"]*" class="sheet db-ffffff dc-1f1d1a">/);
    expect(html).not.toMatch(/class="[^"]*" [^>]*class=/);
    // The dark scheme's rules take the tint, after the narrow screen's.
    const tinted = atTint({ html }, "rose").html;
    expect(tinted).toContain("@media (max-width:560px)");
    expect(tinted).not.toContain("#ff9a5c");
  });

  it("shows the eyes across from the wordmark, looking down at the email, in colors that turn dark and take a tint (owner's request, 2026-10-28)", () => {
    const { html } = composeLetter(letter);
    const header = /<a href="https:\/\/staging\.example" style="color:#1f1d1a;font-size:20px[^>]*>.*?<\/a><\/td><td align="right" style="font-size:0;line-height:0">(.*?)<\/td><\/tr><\/table>/.exec(html);
    expect(header).not.toBeNull();
    const eyes = [...header![1]!.matchAll(/border:3px solid (#[0-9a-f]{6});border-radius:([^;]+);[^"]*text-align:left"[^>]*><span style="display:block;width:(\d+)px;height:\d+px;margin:([\d.]+)px 0 0 ([\d.]+)px;/g)];
    // A round human eye and a square machine one, each a ring around a pupil.
    expect(eyes.map((eye) => [eye[1], eye[2]])).toEqual([["#1f1d1a", "50%"], ["#c2410c", "4px"]]);
    for (const [, , , width, top, left] of eyes) {
      // Inside a 10-pixel ring, below the middle and left of it: looking down at the heading.
      const middle = (10 - Number(width)) / 2;
      expect(Number(top)).toBeGreaterThan(middle);
      expect(Number(left)).toBeLessThan(middle);
    }
    const rules = /<style>(.*)<\/style><\/head>/.exec(html)?.[1] ?? "";
    expect(rules).toContain(".do-1f1d1a{border-color:#f2f0ec!important}");
    expect(rules).toContain(".do-c2410c{border-color:#ff9a5c!important}");
    expect(atTint({ html }, "mono").html).toContain("border:3px solid #2f2d2a");
  });

  it("follows a dark color scheme where the mail app lets it, in the board's dark colors (owner's request, 2026-10-27)", () => {
    const { html } = composeLetter({ ...letter, button: { label: "Sign in", url: "https://staging.example/signin" } });
    expect(html).toContain('<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">');
    const rules = /<style>(.*)<\/style><\/head>/.exec(html)?.[1] ?? "";
    expect(rules).toContain(":root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){");
    // The page, the card, the words, the rule above the foot, and the button.
    expect(html).toContain('<body style="margin:0;background:#f7f6f3" class="page db-f7f6f3">');
    for (const rule of [
      ".db-f7f6f3{background-color:#121110!important}",
      ".db-ffffff{background-color:#1b1a18!important}",
      ".dc-1f1d1a{color:#f2f0ec!important}",
      ".dc-55524c{color:#aba69e!important}",
      ".dc-6f6b64{color:#948f87!important}",
      ".dl-e7e5e0{border-top-color:#2c2a27!important}",
      ".db-c2410c{background-color:#ff9a5c!important}",
      ".dc-ffffff{color:#1b1a18!important}",
    ]) {
      expect(rules).toContain(rule);
    }
    expect(html).toMatch(/background:#c2410c;color:#ffffff;[^"]*" class="db-c2410c dc-ffffff">Sign in<\/a>/);
    // Only the colors this email uses.
    expect(rules).not.toContain("fff1e8");
    // A tint's own dark accent, and its light one inline.
    const mono = atTint({ html }, "mono").html;
    expect(mono).toContain(".db-c2410c{background-color:#e7e5e0!important}");
    expect(mono).toContain("background:#2f2d2a;color:#ffffff;");
  });
});
