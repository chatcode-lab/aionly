import { describe, expect, it } from "vitest";

import { composeDigest, periodStart, SEND_HOUR_UTC } from "./compose";

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

  it("escapes everything people wrote, and carries the unsubscribe link", () => {
    const email = composeDigest({ frequency: "weekly", posts: [post], origin: "https://aion.ly", unsubscribeUrl: "https://aion.ly/digest/unsubscribe?token=t" });
    expect(email.subject).toBe('Top of aion.ly this week: A <song> & "more"');
    expect(email.html).not.toContain("<song>");
    expect(email.html).not.toContain("<b>with</b>");
    expect(email.html).toContain("A &#60;song&#62; &#38; &#34;more&#34;");
    expect(email.html).toContain("https://aion.ly/digest/unsubscribe?token=t");
    expect(email.text).toContain("12 points · 1 comment · by quiet_otter");
    expect(email.text).toContain("Unsubscribe: https://aion.ly/digest/unsubscribe?token=t");
  });
});

describe("when a period's digest is due", () => {
  it("is today at the sending hour, or yesterday before it", () => {
    expect(periodStart("daily", at("2026-10-15T09:00:00Z"))).toBe(at(`2026-10-15T0${SEND_HOUR_UTC}:00:00Z`));
    expect(periodStart("daily", at("2026-10-15T06:59:00Z"))).toBe(at("2026-10-14T07:00:00Z"));
  });

  it("is this Monday for the weekly one", () => {
    // October 15, 2026 is a Thursday.
    expect(periodStart("weekly", at("2026-10-15T09:00:00Z"))).toBe(at("2026-10-12T07:00:00Z"));
    expect(periodStart("weekly", at("2026-10-12T06:00:00Z"))).toBe(at("2026-10-05T07:00:00Z"));
  });

  it("is the first of the month for the monthly one", () => {
    expect(periodStart("monthly", at("2026-10-15T09:00:00Z"))).toBe(at("2026-10-01T07:00:00Z"));
    expect(periodStart("monthly", at("2026-10-01T05:00:00Z"))).toBe(at("2026-09-01T07:00:00Z"));
    expect(periodStart("monthly", at("2026-01-01T05:00:00Z"))).toBe(at("2025-12-01T07:00:00Z"));
  });
});
