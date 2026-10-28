import { describe, expect, it } from "vitest";

import { pictureFrame } from "./framing";

type Pixel = [number, number, number, number];

/** A picture `width` by `height`, each pixel from `paint`. */
function picture(width: number, height: number, paint: (x: number, y: number) => Pixel): Uint8Array {
  const pixels = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) pixels.set(paint(x, y), (y * width + x) * 4);
  }
  return pixels;
}

/** Something to see: colors that vary from pixel to pixel. */
const scene = (x: number, y: number): Pixel => [(x * 37 + y * 11) % 256, (x * 13 + y * 29) % 256, (x * 7 + y * 53) % 256, 255];
const BLACK: Pixel = [3, 2, 5, 255];
const CLEAR: Pixel = [0, 0, 0, 0];

describe("a picture's frame on a cover", () => {
  it("leaves out a video thumbnail's black bars, above and below or at the sides", () => {
    const letterbox = picture(40, 30, (x, y) => (y < 4 || y >= 26 ? BLACK : scene(x, y)));
    expect(pictureFrame(letterbox, 40, 30)).toEqual({ left: 0, top: 4 / 30, right: 1, bottom: 26 / 30 });
    const pillarbox = picture(40, 30, (x, y) => (x < 5 || x >= 35 ? BLACK : scene(x, y)));
    expect(pictureFrame(pillarbox, 40, 30)).toEqual({ left: 5 / 40, top: 0, right: 35 / 40, bottom: 1 });
    // A channel's logo in a bar is not enough to keep it.
    const marked = picture(100, 30, (x, y) => (y < 4 && x === 90 ? [255, 255, 255, 255] : y < 4 || y >= 26 ? BLACK : scene(x, y)));
    expect(pictureFrame(marked, 100, 30)?.top).toBe(4 / 30);
  });

  it("keeps black that is not a pair of bars: a dark picture's edge is part of it", () => {
    const night = picture(40, 30, (x, y) => (y < 8 ? BLACK : scene(x, y)));
    expect(pictureFrame(night, 40, 30)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
    const uneven = picture(40, 30, (x, y) => (y < 3 || y >= 22 ? BLACK : scene(x, y)));
    expect(pictureFrame(uneven, 40, 30)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
  });

  it("leaves out a transparent edge on any side, as a screenshot's around its window", () => {
    const window = picture(40, 30, (x, y) => (x < 2 || x >= 37 || y < 3 || y >= 29 ? CLEAR : scene(x, y)));
    expect(pictureFrame(window, 40, 30)).toEqual({ left: 2 / 40, top: 3 / 30, right: 37 / 40, bottom: 29 / 30 });
    // A faint shadow is still the edge.
    const shadowed = picture(40, 30, (x, y) => (y < 3 ? [0, 0, 0, 40] : scene(x, y)));
    expect(pictureFrame(shadowed, 40, 30)?.top).toBe(3 / 30);
  });

  it("keeps a picture whole when nothing is around it, a plain sky included", () => {
    expect(pictureFrame(picture(40, 30, scene), 40, 30)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
    const sky = picture(40, 30, (x, y) => (y < 12 ? [180, 215, 245, 255] : scene(x, y)));
    expect(pictureFrame(sky, 40, 30)).toEqual({ left: 0, top: 0, right: 1, bottom: 1 });
  });

  it("finds nothing in a picture of one color, or one that is all edge", () => {
    expect(pictureFrame(picture(40, 30, () => [219, 242, 255, 255]), 40, 30)).toBeNull();
    expect(pictureFrame(picture(40, 30, () => BLACK), 40, 30)).toBeNull();
    expect(pictureFrame(picture(40, 30, () => CLEAR), 40, 30)).toBeNull();
    // Nearly one color, as compression leaves a plain frame.
    expect(pictureFrame(picture(40, 30, (x, y) => [219 + ((x + y) % 3), 242, 255, 255]), 40, 30)).toBeNull();
    // A plain middle between black bars is nothing too.
    expect(pictureFrame(picture(40, 30, (x, y) => (y < 4 || y >= 26 ? BLACK : [219, 242, 255, 255])), 40, 30)).toBeNull();
  });
});
