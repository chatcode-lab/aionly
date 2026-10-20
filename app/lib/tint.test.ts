import { describe, expect, it } from "vitest";

import { composeOfferEmail } from "./offers/compose";
import { atTint, composeLetter, forReader } from "./mail/layout";
import { parseTint, storedTint, TINT_COLORS } from "./tint";

describe("a tint", () => {
  it("is one of the five, from a form or the profile, else orange", () => {
    expect(parseTint("teal")).toBe("teal");
    expect(parseTint("blue")).toBeNull();
    expect(storedTint(null)).toBe("orange");
    expect(storedTint("rose")).toBe("rose");
    expect(storedTint("nonsense")).toBe("orange");
  });
});

describe("an email in its recipient's tint", () => {
  const letter = composeLetter({
    subject: "A subject",
    preview: "",
    heading: "Colors like #c2410c typed in a heading stay",
    paragraphs: ["A paragraph."],
    button: { label: "Open", url: "https://aion.ly/" },
    why: "Why it came.",
    origin: "https://aion.ly",
  });

  it("swaps orange and its pale ground in styles alone, for the tint's light colors", () => {
    const teal = atTint(letter, "teal");
    expect(teal.html).toContain(`background:${TINT_COLORS.teal.light.accent}`);
    expect(teal.html).toContain(`color:${TINT_COLORS.teal.light.accent}`);
    expect(teal.html).not.toMatch(/style="[^"]*#c2410c/);
    expect(teal.html).toContain("Colors like #c2410c typed in a heading stay");
    expect(atTint(letter, "orange")).toBe(letter);

    const offer = atTint(composeOfferEmail({ kind: "welcome", left: 20 * 3600, origin: "https://aion.ly", unsubscribeUrl: "https://aion.ly/u" }), "rose");
    expect(offer.html).toContain(`background:${TINT_COLORS.rose.light["accent-soft"]}`);
    expect(offer.html).not.toContain("#fff1e8");
  });

  it("comes with the recipient's text size too", () => {
    const read = forReader(letter, { textSize: 130, tint: "green" });
    expect(read.html).toContain("font-size:20px;line-height:29px");
    expect(read.html).toContain(TINT_COLORS.green.light.accent);
  });
});
