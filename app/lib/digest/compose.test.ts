import { describe, expect, it } from "vitest";

import { generatedAvatar } from "../avatar";
import { composeDigest, EXCERPT_MAX, FOUNDER_NOTE, periodName, periodStart, periodWindow } from "./compose";

const at = (iso: string) => Date.parse(iso) / 1000;

describe("the digest email", () => {
  const post = {
    title: 'A <song> & "more"',
    url: "https://aion.ly/p/abc1234/a-song",
    source: "Suno",
    sourceUrl: "https://suno.com/song/abc" as string | null,
    score: 12,
    comments: 1,
    author: "quiet_otter",
    authorId: "u_otter",
    authorPhoto: null as string | null,
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

  it("shows each author's picture by their name: their own, or their initial on their color", () => {
    const pictured = { ...post, title: "Pictured", author: "<maker>", authorPhoto: "https://aion.ly/img/a.jpg?x=1&y=2" };
    const email = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [post, pictured], discussed: [] });
    expect(email.html).toContain(`by <img src="https://aion.ly/img/a.jpg?x=1&#38;y=2" width="16" height="16" alt=""`);
    // Kept with the name, on one line.
    expect(email.html).toContain('· <span style="white-space:nowrap">by <img');
    expect(email.html).toContain("&#60;maker&#62;</span></div>");
    // Its initial on its color, kept as it is on a dark screen.
    const drawn = /by <span style="([^"]*)">Q<\/span>quiet_otter<\/span><\/div>/.exec(email.html);
    expect(drawn?.[1]).toContain(`background:${generatedAvatar("u_otter", "quiet_otter").color}`);
    // Sized from its own font size, so it grows with the reader's text.
    expect(drawn?.[1]).toContain("font-size:10px;width:1.6em;height:1.6em");
    expect(email.text).toContain("12 points · 1 comment · by quiet_otter\n");
  });

  it("names the source as a link of the line's own color, what a hosted post is as it is, and nothing without either", () => {
    const hosted = { ...post, title: "Hosted", source: "Article", sourceUrl: null };
    const bare = { ...post, title: "Bare", source: null, sourceUrl: null };
    const email = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [post, hosted, bare], discussed: [] });
    expect(email.html).toContain('<a href="https://suno.com/song/abc" style="color:#6f6b64;text-decoration:none" class="dc-6f6b64">Suno</a> · 12 points');
    expect(email.html).toContain('class="dc-6f6b64">Article · 12 points');
    expect(email.html).toContain('class="dc-6f6b64">12 points · 1 comment · <span');
    expect(email.text).toContain("Suno · 12 points · 1 comment · by quiet_otter");
    expect(email.text).toContain("Bare\n12 points · 1 comment · by quiet_otter");
  });

  it("ends with the founder asking what readers make of it, with their picture and where to reach them", () => {
    const email = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [post], discussed: [], founderPhoto: "https://aion.ly/img/boris.jpg" });
    expect(email.html).toContain(`<img src="https://aion.ly/img/boris.jpg" width="44" height="44"`);
    expect(email.html).toContain(">Boris Karulin</div>");
    expect(email.html).toContain(`>${FOUNDER_NOTE}</div>`);
    expect(email.html).toContain(
      '<a href="https://aion.ly/@boris" style="color:#6f6b64" class="dc-6f6b64">aion.ly/@boris</a> · <a href="https://x.com/karulin" style="color:#6f6b64" class="dc-6f6b64">x.com/karulin</a> · <a href="mailto:hey@aion.ly" style="color:#6f6b64" class="dc-6f6b64">hey@aion.ly</a>',
    );
    expect(email.text).toContain(`Boris Karulin\n${FOUNDER_NOTE}\nhttps://aion.ly/@boris · https://x.com/karulin · hey@aion.ly\n`);
    // Without a picture, the rest stays.
    const bare = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [post], discussed: [] });
    expect(bare.html).not.toContain('width="44"');
    expect(bare.html).toContain(FOUNDER_NOTE);
  });

  it("cuts a long excerpt at a word, with an ellipsis and a link to read the rest", () => {
    const long = { ...post, excerpt: `${"Pick a place on a map and print it. ".repeat(10)}Joey, its maker, describes building it.` };
    const email = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [long], discussed: [] });
    const shown = email.text.split("\n").find((line) => line.startsWith("Pick a place"))!;
    expect(shown.length).toBeLessThanOrEqual(EXCERPT_MAX);
    expect(shown.length).toBeGreaterThan(EXCERPT_MAX - 40);
    expect(shown).toMatch(/ [A-Za-z]+…$/);
    expect(shown).not.toMatch(/[.,]…$/);
    expect(email.html).toContain(`… <a href="https://aion.ly/p/abc1234/a-song"`);
    expect(email.html).toContain(">Read more</a>");
    // A short one is whole, with no link.
    const short = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [post], discussed: [] });
    expect(short.html).toContain("Made &#60;b&#62;with&#60;/b&#62; care</div>");
    expect(short.html).not.toContain("Read more");
    // The feed's own cut still gets the link.
    const cut = composeDigest({ ...base, frequency: "daily", chosen: "daily", period: "the past day", voted: [{ ...post, excerpt: "Made with care…" }], discussed: [] });
    expect(cut.html).toContain("Read more");
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
