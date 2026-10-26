import { describe, expect, it } from "vitest";

import {
  distanceToBox,
  LOGO_CREEP,
  LOGO_REACH,
  LOOK_RANGE,
  lookToward,
  nextCover,
  swiped,
  TOUCH_SWIPE,
  UNCOVERED,
} from "./logo";

const BOX = { left: 10, top: 0, right: 70, bottom: 52 };

describe("distanceToBox", () => {
  it("is 0 inside the box and on its edge", () => {
    expect(distanceToBox(40, 26, BOX)).toBe(0);
    expect(distanceToBox(70, 52, BOX)).toBe(0);
  });

  it("measures to the nearest side or corner", () => {
    expect(distanceToBox(100, 26, BOX)).toBe(30);
    expect(distanceToBox(40, 92, BOX)).toBe(40);
    expect(distanceToBox(73, 56, BOX)).toBe(5);
  });
});

describe("nextCover", () => {
  it("covers the eyes in one move over the logo", () => {
    expect(nextCover(0, UNCOVERED)).toEqual({ cover: 1, lifted: false, snap: true });
  });

  it("creeps part way as the cursor nears, and not at all out of reach", () => {
    expect(nextCover(LOGO_REACH / 2, UNCOVERED)).toEqual({ cover: LOGO_CREEP / 2, lifted: false, snap: false });
    expect(nextCover(LOGO_REACH, UNCOVERED).cover).toBe(0);
    expect(nextCover(LOGO_REACH * 3, UNCOVERED).cover).toBe(0);
  });

  it("lifts in one move as the cursor leaves, and stays up until it is out of reach", () => {
    const covered = nextCover(0, UNCOVERED);
    const left = nextCover(4, covered);
    expect(left).toEqual({ cover: 0, lifted: true, snap: true });
    // Moving away slowly, it does not creep back down.
    const away = nextCover(60, left);
    expect(away).toEqual({ cover: 0, lifted: true, snap: true });
    const gone = nextCover(LOGO_REACH + 1, away);
    expect(gone.lifted).toBe(false);
    // Coming back, it creeps again.
    expect(nextCover(LOGO_REACH / 2, gone).cover).toBe(LOGO_CREEP / 2);
  });

  it("covers again when the cursor comes back over it while lifted", () => {
    const left = nextCover(4, nextCover(0, UNCOVERED));
    expect(nextCover(0, left).cover).toBe(1);
  });

  it("lifts when there is no cursor, as after a tap", () => {
    expect(nextCover(null, nextCover(0, UNCOVERED))).toEqual({ cover: 0, lifted: false, snap: true });
  });
});

describe("lookToward", () => {
  it("looks straight ahead at a cursor on the eyes", () => {
    expect(lookToward(0, 0)).toEqual([0, 0]);
  });

  it("looks toward the cursor, never past the range", () => {
    const [x, y] = lookToward(300, -400);
    expect(x).toBeGreaterThan(0);
    expect(y).toBeLessThan(0);
    expect(y / x).toBeCloseTo(-4 / 3);
    expect(Math.hypot(x, y)).toBeLessThan(LOOK_RANGE);
    expect(Math.hypot(...lookToward(1e6, 0))).toBeCloseTo(LOOK_RANGE, 3);
  });

  it("looks less at a cursor close by", () => {
    expect(Math.hypot(...lookToward(20, 0))).toBeLessThan(Math.hypot(...lookToward(200, 0)));
  });
});

describe("swiped", () => {
  it("tells a swipe from a tap by how far the finger moved", () => {
    const from = { x: 100, y: 300 };
    expect(swiped(from, { x: 103, y: 296 })).toBe(false);
    expect(swiped(from, { x: 100, y: 300 - TOUCH_SWIPE })).toBe(true);
    expect(swiped(from, { x: 160, y: 300 })).toBe(true);
  });
});
