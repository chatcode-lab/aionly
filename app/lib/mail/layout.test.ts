import { describe, expect, it } from "vitest";

import { composeLetter } from "./layout";

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
    const named = (color: string) => `<a href="https://staging.example" style="color:${color};text-decoration:none">aion.ly</a>`;
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
});
