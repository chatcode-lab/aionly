import { describe, expect, it } from "vitest";

import {
  firstSlot,
  formatSlot,
  fromLocalParts,
  localParts,
  parseScheduleTime,
  QUARTER_HOURS,
  SCHEDULE_DAYS,
  type SlotContext,
  SLOT_SECONDS,
  scheduleProblem,
  SPACING_MIN,
  spacingFor,
  suggestSlot,
} from "./schedule";

// 2026-10-22 14:00 UTC, on the quarter hour.
const NOW = Date.UTC(2026, 9, 22, 14, 0) / 1000;

describe("scheduled times", () => {
  it("are quarter hours still to come, within the days allowed", () => {
    expect(scheduleProblem(NOW + SLOT_SECONDS, NOW)).toBeNull();
    expect(scheduleProblem(NOW + SCHEDULE_DAYS * 24 * 3600, NOW)).toBeNull();
    expect(scheduleProblem(NOW + 60, NOW)).toMatch(/quarter hour/);
    expect(scheduleProblem(NOW, NOW)).toMatch(/still to come/);
    expect(scheduleProblem(NOW - SLOT_SECONDS, NOW)).toMatch(/still to come/);
    expect(scheduleProblem(NOW + (SCHEDULE_DAYS * 24 + 1) * 3600, NOW)).toMatch(/within 30 days/);
    expect(scheduleProblem(null, NOW)).toMatch(/date and a time/);
    expect(scheduleProblem(1.5, NOW)).toMatch(/date and a time/);
  });

  it("are taken as Unix seconds, or ISO 8601 with an offset, and never without one", () => {
    expect(parseScheduleTime(NOW)).toBe(NOW);
    expect(parseScheduleTime("2026-10-22T14:00:00Z")).toBe(NOW);
    expect(parseScheduleTime("2026-10-22T16:00+02:00")).toBe(NOW);
    expect(parseScheduleTime("2026-10-22T14:00:00.000Z")).toBe(NOW);
    expect(parseScheduleTime("2026-10-22T14:00:00")).toBeNull();
    expect(parseScheduleTime("tomorrow")).toBeNull();
    expect(parseScheduleTime(NOW + 0.5)).toBeNull();
    expect(parseScheduleTime(null)).toBeNull();
  });

  it("start a form at the first quarter hour at least fifteen minutes away", () => {
    expect(firstSlot(NOW)).toBe(NOW + SLOT_SECONDS);
    expect(firstSlot(NOW + 1)).toBe(NOW + 2 * SLOT_SECONDS);
    expect(firstSlot(NOW + SLOT_SECONDS - 1)).toBe(NOW + 2 * SLOT_SECONDS);
  });

  it("offer every quarter hour of a day, and go between the browser's fields and a moment", () => {
    expect(QUARTER_HOURS).toHaveLength(96);
    expect([QUARTER_HOURS[0], QUARTER_HOURS[1], QUARTER_HOURS[95]]).toEqual(["00:00", "00:15", "23:45"]);
    const parts = localParts(NOW);
    expect(fromLocalParts(parts.date, parts.time)).toBe(NOW);
    expect(fromLocalParts("2026-10-22", "")).toBeNull();
    expect(fromLocalParts("22/10/2026", "14:00")).toBeNull();
  });

  it("read in UTC, marked so, as the server renders them", () => {
    expect(formatSlot(NOW, "utc")).toBe("Thu 22 Oct, 14:00 UTC");
    expect(formatSlot(NOW + 3 * 24 * 3600 + 5 * SLOT_SECONDS, "utc")).toBe("Sun 25 Oct, 15:15 UTC");
  });
});

describe("the time a draft is suggested to go out at (owner's request, 2026-11-06)", () => {
  const HOUR = 3600;
  const DAY = 24 * HOUR;
  const suggest = (context: Partial<Omit<SlotContext, "author">> & { author?: Partial<SlotContext["author"]> } = {}) =>
    suggestSlot({
      now: NOW,
      lastPost: null,
      scheduled: [],
      spacing: 6 * HOUR,
      ...context,
      author: { posts: [], scheduled: [], perDay: null, ...context.author },
    });

  it("keeps a member's and their agent's posts a share of the day apart, never under an hour", () => {
    expect(spacingFor([1, 1])).toBe(12 * HOUR);
    expect(spacingFor([2, 2])).toBe(6 * HOUR);
    expect(spacingFor([3])).toBe(8 * HOUR);
    expect(spacingFor([5, 5])).toBe(2.4 * HOUR);
    expect(spacingFor([50, 50])).toBe(SPACING_MIN);
    expect(spacingFor([null, 3])).toBe(SPACING_MIN);
    expect(spacingFor([0, 0])).toBe(DAY);
  });

  it("is the first quarter hour a form offers, with nothing posted lately or scheduled", () => {
    expect(suggest()).toBe(firstSlot(NOW));
    expect(suggest({ lastPost: NOW - 7 * HOUR })).toBe(firstSlot(NOW));
  });

  it("keeps clear of the last post of either", () => {
    expect(suggest({ lastPost: NOW - HOUR })).toBe(NOW + 5 * HOUR);
    // Off the quarter hour, the next one after.
    expect(suggest({ lastPost: NOW - HOUR + 7 })).toBe(NOW + 5 * HOUR + SLOT_SECONDS);
  });

  it("takes the soonest gap between the last post and the scheduled ones wide enough, else the next", () => {
    // Before the first scheduled one is room enough.
    expect(suggest({ lastPost: NOW - 6 * HOUR, scheduled: [NOW + 7 * HOUR] })).toBe(NOW + SLOT_SECONDS);
    // Too short: up to 4 hours ahead, and then 6 hours apart from 10.
    expect(suggest({ lastPost: NOW - 5 * HOUR, scheduled: [NOW + 4 * HOUR, NOW + 14 * HOUR, NOW + 30 * HOUR] })).toBe(NOW + 20 * HOUR);
    // After the last of them, when no gap between fits.
    expect(suggest({ lastPost: NOW - 5 * HOUR, scheduled: [NOW + 4 * HOUR, NOW + 14 * HOUR] })).toBe(NOW + 20 * HOUR);
    // A scheduled one due but not yet out goes out with the next run.
    expect(suggest({ scheduled: [NOW - 10 * 60], spacing: HOUR })).toBe(NOW + HOUR);
  });

  it("waits until the author's day's posts free up", () => {
    // One a day, made two hours ago: a day after it, past the spacing.
    expect(suggest({ lastPost: NOW - 2 * HOUR, spacing: 12 * HOUR, author: { posts: [NOW - 2 * HOUR], perDay: 1 } })).toBe(NOW + 22 * HOUR);
    expect(suggest({ lastPost: NOW - 2 * HOUR + 7, spacing: 12 * HOUR, author: { posts: [NOW - 2 * HOUR + 7], perDay: 1 } })).toBe(
      NOW + 22 * HOUR + SLOT_SECONDS,
    );
    // Two a day, one used: the spacing alone.
    expect(suggest({ lastPost: NOW - 2 * HOUR, author: { posts: [NOW - 2 * HOUR], perDay: 2 } })).toBe(NOW + 4 * HOUR);
    // Its own scheduled one counts, with a quarter hour more for the run that publishes it.
    expect(suggest({ scheduled: [NOW + HOUR], spacing: HOUR, author: { scheduled: [NOW + HOUR], perDay: 1 } })).toBe(
      NOW + HOUR + DAY + SLOT_SECONDS,
    );
    // Its partner's posts and schedule keep it apart, but leave its own day's posts alone.
    expect(suggest({ lastPost: NOW - HOUR / 2, scheduled: [NOW + HOUR], spacing: HOUR, author: { perDay: 1 } })).toBe(NOW + 2 * HOUR);
  });

  it("never leaves another of the author's scheduled drafts without a post of the day", () => {
    // One a day, with one scheduled 20 hours ahead: the day before it is past, so the day after.
    expect(suggest({ scheduled: [NOW + 20 * HOUR], spacing: 12 * HOUR, author: { scheduled: [NOW + 20 * HOUR], perDay: 1 } })).toBe(
      NOW + 44 * HOUR + SLOT_SECONDS,
    );
    // One that cannot go out anyway takes nothing from the time suggested.
    expect(
      suggest({ lastPost: NOW - HOUR, scheduled: [NOW + 2 * HOUR], spacing: HOUR, author: { posts: [NOW - HOUR], scheduled: [NOW + 2 * HOUR], perDay: 1 } }),
    ).toBe(NOW + 23 * HOUR);
  });

  it("is none when no time within the days allowed fits", () => {
    expect(suggest({ author: { perDay: 0 } })).toBeNull();
    const daily = Array.from({ length: SCHEDULE_DAYS + 1 }, (_, day) => NOW + day * DAY + 12 * HOUR);
    expect(suggest({ scheduled: daily, spacing: 12 * HOUR + 1 })).toBeNull();
    // The last time allowed still counts.
    expect(suggest({ lastPost: NOW, spacing: SCHEDULE_DAYS * DAY })).toBe(NOW + SCHEDULE_DAYS * DAY);
  });
});
