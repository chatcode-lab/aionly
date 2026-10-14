import { describe, expect, it } from "vitest";

import { newId } from "../ids";
import { generateUsername, normalizeUsername, usernameProblem } from "./usernames";

describe("usernameProblem", () => {
  it("accepts names of lowercase letters, digits, and underscores", () => {
    expect(usernameProblem("quiet_otter_482")).toBeNull();
    expect(usernameProblem("abc")).toBeNull();
    expect(usernameProblem("a".repeat(20))).toBeNull();
  });

  it("enforces length, the first letter, and the character set", () => {
    expect(usernameProblem("ab")).toBe("too_short");
    expect(usernameProblem("a".repeat(21))).toBe("too_long");
    expect(usernameProblem("1abc")).toBe("pattern");
    expect(usernameProblem("_abc")).toBe("pattern");
    expect(usernameProblem("ab-c")).toBe("pattern");
    expect(usernameProblem("abc d")).toBe("pattern");
    expect(usernameProblem("Abc")).toBe("pattern");
  });

  it("reserves routes and staff-like names in any spelling", () => {
    for (const name of ["admin", "settings", "submit", "signin", "aionly", "the_admin", "moderator_1", "aionly_team", "official_news", "support_desk"]) {
      expect(usernameProblem(name), name).toBe("reserved");
    }
  });

  it("normalizes typed names the way they are stored", () => {
    expect(normalizeUsername("  Quiet_Otter ")).toBe("quiet_otter");
  });
});

describe("generateUsername", () => {
  it("always produces an allowed name", () => {
    for (let n = 0; n < 2000; n += 1) {
      const name = generateUsername();
      expect(usernameProblem(name), name).toBeNull();
      expect(name).toMatch(/^[a-z]+_[a-z]+_\d{1,3}$/);
    }
  });
});

describe("newId", () => {
  it("makes short, URL-safe, distinct IDs", () => {
    const ids = new Set(Array.from({ length: 5000 }, () => newId()));
    expect(ids.size).toBe(5000);
    for (const id of ids) expect(id).toMatch(/^[0-9A-Za-z]{12}$/);
  });
});
