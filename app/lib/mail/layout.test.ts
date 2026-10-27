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

  it("follows a dark color scheme where the mail app lets it, in the board's dark colors (owner's request, 2026-10-27)", () => {
    const { html } = composeLetter({ ...letter, button: { label: "Sign in", url: "https://staging.example/signin" } });
    expect(html).toContain('<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark">');
    const rules = /<style>(.*)<\/style><\/head>/.exec(html)?.[1] ?? "";
    expect(rules).toContain(":root{color-scheme:light dark;supported-color-schemes:light dark}@media (prefers-color-scheme:dark){");
    // The page, the card, the words, the rule above the foot, and the button.
    expect(html).toContain('<body style="margin:0;background:#f7f6f3" class="db-f7f6f3">');
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
