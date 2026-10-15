import { describe, expect, it } from "vitest";

import { floorOf, KARMA_FLOOR } from "./moderation";

describe("the karma floor", () => {
  it("is the usual one unless a fresh start set another", () => {
    expect(floorOf(null)).toBe(KARMA_FLOOR);
    expect(floorOf(-170)).toBe(-170);
  });
});
