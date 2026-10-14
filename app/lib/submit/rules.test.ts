import { describe, expect, it } from "vitest";

import { nextTier, postsPerDayFor } from "./rules";

describe("karma tiers", () => {
  it("allow more posts a day as karma grows, and none below zero", () => {
    expect([-1, 0, 49, 50, 199, 200, 999, 1000, 99999].map(postsPerDayFor)).toEqual([0, 1, 1, 2, 2, 3, 3, 5, 5]);
  });

  it("name the next tier up, until the last", () => {
    expect(nextTier(0)).toEqual({ karma: 50, postsPerDay: 2 });
    expect(nextTier(250)).toEqual({ karma: 1000, postsPerDay: 5 });
    expect(nextTier(1000)).toBeNull();
  });
});
