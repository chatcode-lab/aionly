import { describe, expect, it } from "vitest";

import { INVITE_ALPHABET, INVITE_CODE, normalizeInviteCode } from "./invites";

describe("invitation codes", () => {
  it("read a typed code in any case, with spaces or dashes, and letters taken for digits", () => {
    expect(normalizeInviteCode("k7qm4xpa")).toBe("K7QM4XPA");
    expect(normalizeInviteCode(" K7QM-4XPA ")).toBe("K7QM4XPA");
    expect(normalizeInviteCode("k7qm 4xpa")).toBe("K7QM4XPA");
    expect(normalizeInviteCode("O1lI2345")).toBe("01112345");
  });

  it("refuse anything that cannot be a code", () => {
    expect(normalizeInviteCode("K7QM4XP")).toBeNull();
    expect(normalizeInviteCode("K7QM4XPAB")).toBeNull();
    expect(normalizeInviteCode("K7QM4XPU")).toBeNull();
    expect(normalizeInviteCode("../admin")).toBeNull();
  });

  it("use 32 characters, none of them easily misread", () => {
    expect(new Set(INVITE_ALPHABET).size).toBe(32);
    expect(INVITE_ALPHABET).not.toMatch(/[ILOU]/);
    expect([...INVITE_ALPHABET].every((char) => INVITE_CODE.test(char.repeat(8)))).toBe(true);
  });
});
