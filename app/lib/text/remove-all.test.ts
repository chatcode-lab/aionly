import { describe, expect, it } from "vitest";

import { removeAll } from "./remove-all";

describe("removeAll", () => {
  it("removes until nothing is left, so a removal cannot join a new match", () => {
    // Taking "ab" out of "aabb" once joins a new "ab".
    expect("aabb".replace(/ab/g, "")).toBe("ab");
    expect(removeAll("aabb", /ab/g)).toBe("");
    expect(removeAll("a [b]bold[/b] word", /\[[^\]]+\]/g)).toBe("a bold word");
  });
});
