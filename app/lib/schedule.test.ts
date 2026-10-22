import { describe, expect, it } from "vitest";

import { firstSlot, formatSlot, fromLocalParts, localParts, parseScheduleTime, QUARTER_HOURS, SCHEDULE_DAYS, SLOT_SECONDS, scheduleProblem } from "./schedule";

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
