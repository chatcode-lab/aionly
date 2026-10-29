import { describe, expect, it } from "vitest";

import { avatarSources, COLUMN_SIZES, columnSources, emailPicture, resized } from "./resize";

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

  it("cuts a picture for an email to its frame, drawn as large as its box allows (owner's request, 2026-10-29)", () => {
    const box = { width: 520, height: 390 };
    // A video thumbnail, its middle 16:9 between black bars.
    const thumbnail = { width: 480, height: 360, frame: { left: 0, top: 0.125, right: 1, bottom: 0.875 } };
    expect(emailPicture(STORED, thumbnail, box)).toEqual({
      src: `https://media.aion.ly/cdn-cgi/image/trim=45;0;45;0,width=1040,fit=scale-down,format=baseline-jpeg,onerror=redirect/${KEY}`,
      width: 520,
      height: 293,
    });
    // A tall one takes the box's height, and nothing is cut from a whole one.
    const tall = emailPicture(STORED, { width: 1080, height: 1920, frame: { left: 0, top: 0, right: 1, bottom: 1 } }, box);
    expect(tall).toEqual({ src: `https://media.aion.ly/cdn-cgi/image/width=438,fit=scale-down,format=baseline-jpeg,onerror=redirect/${KEY}`, width: 219, height: 390 });
    expect(emailPicture(`/img/${KEY}`, thumbnail, box)).toBeNull();
  });
});
