import { describe, expect, it } from "vitest";

import { avatarSources, COLUMN_SIZES, columnSources, resized } from "./resize";

const KEY = "P70al5CCoiGSzJWUohguhIYJ.jpg";
const STORED = `https://media.aion.ly/${KEY}`;
const at = (width: number) => `https://media.aion.ly/cdn-cgi/image/width=${width},fit=scale-down,format=auto,onerror=redirect/${KEY}`;

describe("resized pictures", () => {
  it("resizes only a stored picture on its public domain", () => {
    expect(resized(STORED, 400)).toBe(at(400));
    expect(resized(`/img/${KEY}`, 400)).toBeNull();
    expect(resized("https://i.ytimg.com/vi/abc/hqdefault.jpg", 400)).toBeNull();
    expect(resized(`https://media.aion.ly/cdn-cgi/image/width=400/${KEY}`, 400)).toBeNull();
    expect(columnSources(`/img/${KEY}`, 1200)).toEqual({});
    expect(avatarSources(`/img/${KEY}`, 18)).toEqual({});
  });

  it("offers a picture in the column at widths up to its own", () => {
    expect(columnSources(STORED, 1200)).toEqual({ srcSet: `${at(400)} 400w, ${at(800)} 800w, ${at(1200)} 1200w`, sizes: COLUMN_SIZES });
    expect(columnSources(STORED, 4032).srcSet).toBe(`${at(400)} 400w, ${at(800)} 800w, ${at(1200)} 1200w, ${at(1600)} 1600w`);
    expect(columnSources(STORED, 300).srcSet).toBe(`${at(300)} 300w`);
    // Of unknown width, every width is offered, and none grows past the picture.
    expect(columnSources(STORED).srcSet).toBe(`${at(400)} 400w, ${at(800)} 800w, ${at(1200)} 1200w, ${at(1600)} 1600w`);
    expect(columnSources(STORED, undefined, "4rem").sizes).toBe("4rem");
  });

  it("offers an avatar small, and as stored on a dense screen", () => {
    expect(avatarSources(STORED, 18)).toEqual({ srcSet: `${at(64)} 64w, ${at(128)} 128w, ${STORED} 320w`, sizes: "18px" });
  });
});
