import { describe, expect, it } from "vitest";

import { closedLately, INVITE_AFTER_MS, INVITE_PAUSE_MS, INVITE_QUIET_MS, inviteDue } from "./digest-invite";
import { CADENCE, frequencyOf } from "./digest/frequency";

describe("the founder's invitation to the digest", () => {
  const interested = { visibleMs: INVITE_AFTER_MS, scrolled: 1, pages: 1, idleMs: INVITE_PAUSE_MS };

  it("shows once a visitor has spent a while with the board, scrolled a screen, and paused", () => {
    expect(inviteDue(interested)).toBe(true);
    expect(inviteDue({ ...interested, visibleMs: INVITE_AFTER_MS - 1 })).toBe(false);
    expect(inviteDue({ ...interested, idleMs: INVITE_PAUSE_MS - 1 })).toBe(false);
  });

  it("counts opening another page as interest, as scrolling a screen is", () => {
    expect(inviteDue({ ...interested, scrolled: 0.5 })).toBe(false);
    expect(inviteDue({ ...interested, scrolled: 0, pages: 2 })).toBe(true);
  });

  it("stays away for a week after it was closed, and a time ahead of the clock keeps nothing away", () => {
    const now = 1_800_000_000_000;
    expect(closedLately(null, now)).toBe(false);
    expect(closedLately(String(now - 1000), now)).toBe(true);
    expect(closedLately(String(now - INVITE_QUIET_MS + 1), now)).toBe(true);
    expect(closedLately(String(now - INVITE_QUIET_MS), now)).toBe(false);
    expect(closedLately(String(now + 60_000), now)).toBe(false);
    expect(closedLately("not a time", now)).toBe(false);
  });
});

describe("a digest chosen on the way in", () => {
  it("is one of the three, as a form or cookie gives it, and says when it comes", () => {
    expect(frequencyOf("weekly")).toBe("weekly");
    expect(frequencyOf("off")).toBeNull();
    expect(frequencyOf(null)).toBeNull();
    expect(CADENCE.daily).toMatch(/morning/);
  });
});
