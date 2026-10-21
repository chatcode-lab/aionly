import { describe, expect, it } from "vitest";

import { composeDigest } from "./digest/compose";
import { atTextSize, composeLetter } from "./mail/layout";
import { parseTextSize, storedTextSize, textScale } from "./text-size";

describe("text size", () => {
  it("is Small, Normal, or Big, from a form or the profile, else Normal", () => {
    expect(parseTextSize("130")).toBe(130);
    expect(parseTextSize(100)).toBe(100);
    expect(parseTextSize("150")).toBeNull();
    expect(parseTextSize("120")).toBeNull();
    expect(parseTextSize("")).toBeNull();
    expect(parseTextSize(null)).toBeNull();
    expect(storedTextSize(null)).toBe(115);
    expect(storedTextSize(130)).toBe(130);
    expect(storedTextSize(999)).toBe(115);
    expect(textScale(115)).toBe(1.15);
  });
});

describe("an email at a member's text size", () => {
  const letter = composeLetter({
    subject: "Font-size:12px in a subject",
    preview: "",
    heading: 'A heading with style="font-size:10px" typed in it',
    paragraphs: ["A paragraph."],
    button: { label: "Open", url: "https://aion.ly/" },
    why: "Why it came.",
    origin: "https://aion.ly",
  });

  it("scales every font size and line height in its styles, and nothing else", () => {
    const larger = atTextSize(letter, 130);
    // 15 px paragraphs with 22 px lines, the 22 px heading, the 12 px footer.
    expect(larger.html).toContain("color:#55524c;font-size:20px;line-height:29px");
    expect(larger.html).toContain("font-size:29px;line-height:36px;font-weight:700");
    expect(larger.html).toContain("color:#6f6b64;font-size:16px;line-height:23px");
    expect(larger.html).not.toMatch(/font-size:(15|22|12)px/);
    // Spacing and the width stay; so does what the member wrote, escaped.
    expect(larger.html).toContain("max-width:560px");
    expect(larger.html).toContain("padding:11px 18px");
    expect(larger.html).toContain("style=&#34;font-size:10px&#34;");
    expect(larger.subject).toBe(letter.subject);
    expect(larger.text).toBe(letter.text);
  });

  it("scales the email's own part too, and leaves Small as it was drawn", () => {
    const digest = composeDigest({
      frequency: "weekly",
      chosen: "weekly",
      period: "last week",
      voted: [{ title: "A post", url: "https://aion.ly/p/a", source: "suno.com", score: 12, comments: 3, author: "nova", authorId: "u_nova", authorPhoto: null, excerpt: "" }],
      discussed: [],
      origin: "https://aion.ly",
      unsubscribeUrl: "https://aion.ly/digest/unsubscribe?token=t",
    });
    expect(atTextSize(digest, 130).html).toContain("font-size:21px;font-weight:600");
    expect(atTextSize(digest, 115).html).toContain("font-size:18px;font-weight:600");
    expect(atTextSize(digest, 100)).toBe(digest);
  });
});
