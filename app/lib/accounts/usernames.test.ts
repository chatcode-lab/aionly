import { describe, expect, it } from "vitest";

import { newId } from "../ids";
import { generateUsername, normalizeUsername, usernameProblem } from "./usernames";

describe("usernameProblem", () => {
  it("accepts names of lowercase letters, digits, and underscores", () => {
    expect(usernameProblem("quiet_otter_482")).toBeNull();
    expect(usernameProblem("abcdef")).toBeNull();
    expect(usernameProblem("a".repeat(20))).toBeNull();
  });

  it("enforces length, the first letter, and the character set", () => {
    expect(usernameProblem("abc")).toBe("too_short");
    expect(usernameProblem("a".repeat(21))).toBe("too_long");
    expect(usernameProblem("1abcde")).toBe("pattern");
    expect(usernameProblem("_abcde")).toBe("pattern");
    expect(usernameProblem("ab-cde")).toBe("pattern");
    expect(usernameProblem("abc def")).toBe("pattern");
    expect(usernameProblem("Abcdef")).toBe("pattern");
  });

  it("keeps 5 characters for the yearly plan and 4 for the Short username package", () => {
    expect(usernameProblem("pixel")).toBe("short_plan");
    expect(usernameProblem("neon")).toBe("short_allowance");
    // The yearly plan allows 5, not 4.
    expect(usernameProblem("pixel", { shortest: 5 })).toBeNull();
    expect(usernameProblem("neon", { shortest: 5 })).toBe("short_allowance");
    // The package allows both.
    expect(usernameProblem("neon", { shortest: 4 })).toBeNull();
    expect(usernameProblem("pixel", { shortest: 4 })).toBeNull();
    expect(usernameProblem("abc", { shortest: 4 })).toBe("too_short");
  });

  it("says an agent's short name needs its owner's package", () => {
    expect(usernameProblem("astro", { agent: true })).toBe("short_agent");
    expect(usernameProblem("astro", { agent: true, shortest: 5 })).toBeNull();
    expect(usernameProblem("astr", { agent: true, shortest: 5 })).toBe("short_agent");
  });

  it("reserves AI brands for everyone, staff and fans too", () => {
    for (const name of ["openai", "claude", "gemini", "codex", "hermes", "kling", "suno", "meta", "anthropic"]) {
      expect(usernameProblem(name, { staff: true, shortest: 4 }), name).toBe("reserved");
    }
    // Only the exact names: a person may still be called "metal_fan".
    expect(usernameProblem("metal_fan")).toBeNull();
  });

  it("reserves routes and staff-like names in any spelling", () => {
    for (const name of ["admin", "settings", "submit", "signin", "aionly", "the_admin", "moderator_1", "aionly_team", "official_news", "support_desk"]) {
      expect(usernameProblem(name), name).toBe("reserved");
    }
  });

  it("leaves names like the board's own to staff and the board's agent", () => {
    expect(usernameProblem("aionly_scout")).toBe("reserved");
    expect(usernameProblem("aionly_scout", { staff: true, agent: true })).toBeNull();
  });

  it("reserves agent, robot, and the board's own name for everyone", () => {
    for (const name of ["agent", "robot", "aionly"]) {
      expect(usernameProblem(name, { staff: true, shortest: 4, agent: true }), name).toBe("reserved");
    }
  });

  it("keeps the endings _agent, _bot, and _ai for agents", () => {
    for (const name of ["scout_agent", "news_bot", "helper_ai"]) {
      expect(usernameProblem(name), name).toBe("agent_ending");
      expect(usernameProblem(name, { staff: true }), name).toBe("agent_ending");
      expect(usernameProblem(name, { agent: true }), name).toBeNull();
    }
    // The bare words are anyone's, and agents may take any other name.
    for (const name of ["secret_agent7", "chatbot", "robotics", "mr_robot", "the_kai", "ai_fan_42", "agent_smith"]) {
      expect(usernameProblem(name), name).toBeNull();
    }
    expect(usernameProblem("quiet_otter_482", { agent: true })).toBeNull();
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
