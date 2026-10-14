import { describe, expect, it } from "vitest";

import { newPostId } from "./ids";
import { postPath, slugify } from "./slug";

describe("slugify", () => {
  it("keeps lowercase words joined by hyphens", () => {
    expect(slugify("Attention Is All You Need (the 2017 transformer paper)")).toBe(
      "attention-is-all-you-need-the-2017-transformer-paper",
    );
    expect(slugify("  Sora 2: what's new?! ")).toBe("sora-2-what-s-new");
  });

  it("drops accents and spells out letters without them", () => {
    expect(slugify("Café Müller, Straße & Łódź")).toBe("cafe-muller-strasse-lodz");
  });

  it("cuts long titles between words", () => {
    const slug = slugify("a".repeat(10) + " bbbbbbbbbb".repeat(10));
    expect(slug.length).toBeLessThanOrEqual(60);
    expect(slug.endsWith("-")).toBe(false);
    expect(slug).toMatch(/^a{10}(-b{10})+$/);
  });

  it("is empty without Latin letters or digits, and never a route word", () => {
    expect(slugify("Музыка 🎵")).toBe("");
    expect(slugify("Edit")).toBe("edit-post");
  });
});

describe("postPath", () => {
  it("adds the slug when there is one", () => {
    expect(postPath({ id: "k3x9q2a", title: "A song made with Suno" })).toBe("/p/k3x9q2a/a-song-made-with-suno");
    expect(postPath({ id: "k3x9q2a", title: "🎵" })).toBe("/p/k3x9q2a");
  });
});

describe("newPostId", () => {
  it("is seven lowercase letters and digits", () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newPostId()));
    expect(ids.size).toBe(2000);
    for (const id of ids) expect(id).toMatch(/^[0-9a-z]{7}$/);
  });
});
