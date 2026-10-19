import { describe, expect, it } from "vitest";

import { composeDigest, periodName, periodStart, periodWindow } from "./compose";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("the digest email", () => {
  const post = {
    title: 'A <song> & "more"',
    url: "https://aion.ly/p/abc1234/a-song",
    source: "suno.com",
    score: 12,
    comments: 1,
    author: "quiet_otter",
    excerpt: "Made <b>with</b> care",
  };

  const base = { origin: "https://aion.ly", unsubscribeUrl: "https://aion.ly/digest/unsubscribe?token=t" };

  it("escapes everything people wrote, and carries the unsubscribe link", () => {
    const email = composeDigest({ ...base, frequency: "weekly", chosen: "weekly", period: "last week", voted: [post], discussed: [] });
    expect(email.subject).toBe('Last week on aion.ly: A <song> & "more"');
    expect(email.html).not.toContain("<song>");
    expect(email.html).not.toContain("<b>with</b>");
    expect(email.html).toContain("A &#60;song&#62; &#38; &#34;more&#34;");
    expect(email.html).toContain("https://aion.ly/digest/unsubscribe?token=t");
    expect(email.text).toContain("12 points · 1 comment · by quiet_otter");
    expect(email.text).toContain("Unsubscribe: https://aion.ly/digest/unsubscribe?token=t");
    expect(email.text).toContain("You get this because you turned on the weekly digest.");
  });

  it("lists the most voted and the most discussed under their own headings, leaving out an empty one", () => {
    const talked = { ...post, title: "Talked about", comments: 9 };
    const both = composeDigest({ ...base, frequency: "monthly", chosen: "daily", period: "October", voted: [post], discussed: [talked] });
    expect(both.subject).toBe('October on aion.ly: A <song> & "more"');
    expect(both.text.indexOf("MOST VOTED")).toBeLessThan(both.text.indexOf("MOST DISCUSSED"));
    expect(both.text.indexOf("MOST DISCUSSED")).toBeLessThan(both.text.indexOf("Talked about"));
    expect(both.text).toContain("It comes with the daily digest you turned on.");
    const discussedOnly = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [], discussed: [talked] });
    expect(discussedOnly.subject).toBe("The past day on aion.ly: Talked about");
    expect(discussedOnly.html).not.toContain("Most voted");
  });
});

describe("what a digest covers", () => {
  // October 15, 2026 is a Thursday.
  const now = at("2026-10-15T09:00:00Z");

  it("ends at 23:00 the night before it is due, so late posts have had time to gather votes", () => {
    expect(periodWindow("daily", now)).toEqual({ from: at("2026-10-13T23:00:00Z"), to: at("2026-10-14T23:00:00Z") });
    expect(periodWindow("weekly", now)).toEqual({ from: at("2026-10-04T23:00:00Z"), to: at("2026-10-11T23:00:00Z") });
    expect(periodWindow("monthly", now)).toEqual({ from: at("2026-08-31T23:00:00Z"), to: at("2026-09-30T23:00:00Z") });
    expect(periodWindow("monthly", at("2027-01-01T20:00:00Z"))).toEqual({ from: at("2026-11-30T23:00:00Z"), to: at("2026-12-31T23:00:00Z") });
  });

  it("starts where the one before ended, so periods of a kind never overlap", () => {
    expect(periodWindow("daily", at("2026-10-16T07:00:00Z")).from).toBe(periodWindow("daily", now).to);
    expect(periodWindow("weekly", at("2026-10-19T19:00:00Z")).from).toBe(periodWindow("weekly", now).to);
    // November 1, 2026 is a Sunday and the 2nd a Monday, so November's goes on Tuesday the 3rd.
    expect(periodWindow("monthly", at("2026-11-03T19:00:00Z")).from).toBe(periodWindow("monthly", now).to);
  });

  it("is named by its kind, and a month by its name", () => {
    expect(periodName("daily", { to: 0 })).toBe("the past day");
    expect(periodName("weekly", { to: 0 })).toBe("last week");
    expect(periodName("monthly", periodWindow("monthly", now))).toBe("September");
    expect(periodName("monthly")).toBe("the past month");
  });
});

describe("when a period's digest is due", () => {
  it("is 07:00 every day", () => {
    expect(periodStart("daily", at("2026-10-15T09:00:00Z"))).toBe(at("2026-10-15T07:00:00Z"));
    expect(periodStart("daily", at("2026-10-15T06:59:00Z"))).toBe(at("2026-10-14T07:00:00Z"));
  });

  it("is Monday at 19:00 for the weekly one", () => {
    expect(periodStart("weekly", at("2026-10-15T09:00:00Z"))).toBe(at("2026-10-12T19:00:00Z"));
    expect(periodStart("weekly", at("2026-10-12T18:00:00Z"))).toBe(at("2026-10-05T19:00:00Z"));
  });

  it("is the month's first working day at 19:00 for the monthly one, but never a Monday, the weekly one's day", () => {
    expect(periodStart("monthly", at("2026-10-15T09:00:00Z"))).toBe(at("2026-10-01T19:00:00Z"));
    expect(periodStart("monthly", at("2026-10-01T18:00:00Z"))).toBe(at("2026-09-01T19:00:00Z"));
    // February 1, 2027 is a Monday; May 1, 2027 a Saturday.
    expect(periodStart("monthly", at("2027-02-10T00:00:00Z"))).toBe(at("2027-02-02T19:00:00Z"));
    expect(periodStart("monthly", at("2027-05-10T00:00:00Z"))).toBe(at("2027-05-04T19:00:00Z"));
    expect(periodStart("monthly", at("2027-01-01T05:00:00Z"))).toBe(at("2026-12-01T19:00:00Z"));
  });
});
