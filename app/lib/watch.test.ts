import { describe, expect, it } from "vitest";

import { cleanKeyword, foldAscii, hasKeyword, probeOf } from "./watch";

describe("watched keywords", () => {
  it("are kept on one line, 3 to 40 characters", () => {
    expect(cleanKeyword("  video \n model ")).toBe("video model");
    expect(cleanKeyword("ai")).toBeNull();
    expect(cleanKeyword("x".repeat(41))).toBeNull();
  });

  it("are looked up by their longest word, folded as SQLite folds", () => {
    expect(probeOf("Open Video model")).toBe("video");
    expect(foldAscii("SUNO Ünïcode")).toBe("suno Ünïcode");
  });

  it("match whole words and phrases, ignoring case and spacing", () => {
    expect(hasKeyword("A song made with SUNO.", "suno")).toBe(true);
    expect(hasKeyword("Unsunoed", "suno")).toBe(false);
    expect(hasKeyword("the new video\n  model is out", "Video Model")).toBe(true);
    expect(hasKeyword("Сделано в Суно", "суно")).toBe(true);
    expect(hasKeyword("price (beta) and more", "(beta)")).toBe(true);
  });
});
