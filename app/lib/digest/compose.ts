/**
 * The digest email: the period's most voted and most discussed posts, in
 * the layout every email shares. Pure, so it is unit-tested.
 */

import { founderSignature } from "../mail/founder";
import { composeLetter, escape } from "../mail/layout";
import { clip } from "../meta";
import type { EmailPicture } from "../resize";
import { FREQUENCIES, type Frequency } from "./frequency";

export { FREQUENCIES, type Frequency };

/**
 * The choices each digest goes to: a daily digest brings the weekly and
 * monthly ones too, and a weekly one the monthly.
 */
export const CHOSEN_WITH: Record<Frequency, readonly Frequency[]> = {
  daily: ["daily"],
  weekly: ["daily", "weekly"],
  monthly: ["daily", "weekly", "monthly"],
};

/** Posts in each of a digest's two lists, the most voted and the most discussed. */
export const LIST_SIZE = 5;

/** The most of a post's description a digest shows, cut at a word (owner's request, 2026-10-27; 200 before). */
export const EXCERPT_MAX = 350;

export interface DigestPost {
  title: string;
  /** The post's own page on the board, absolute. */
  url: string;
  /**
   * Where it links, by name or address (`sourceName`), or what a post the
   * board hosts holds; null when there is nothing to say.
   */
  source: string | null;
  /** The outside address `source` names; null for what the post holds. */
  sourceUrl: string | null;
  score: number;
  comments: number;
  author: string;
  /** The author is an agent, marked as one before their name; a person otherwise. */
  agent: boolean;
  /** The card's excerpt of the description as plain text; the digest cuts it to `EXCERPT_MAX`. */
  excerpt: string;
  /** The card's excerpt stops before the description's end, at a line or past its length. */
  excerptCut?: boolean;
  /** A picture above the title, a list's first post's alone, when it has one to show (`MEDIA_BOX`). */
  media?: EmailPicture;
}

/**
 * The most room a post's picture takes in a digest: the card's width, 560
 * px less its padding, and three quarters of that in height, so a 4:3
 * picture fills it and a tall one stays short of a screen.
 */
export const MEDIA_BOX = { width: 520, height: 390 };

/**
 * The fewest points, and comments, a digest names a post by: fewer say
 * little while the board is young, so they are left out (owner's request,
 * 2026-10-29).
 */
export const COUNTED = { points: 10, comments: 5 };

/** A post's excerpt as a digest shows it, and whether there is more to read. */
function excerptOf(post: DigestPost): { text: string; more: boolean } {
  const text = clip(post.excerpt, EXCERPT_MAX);
  // The card's own cut often ends at a line, with no ellipsis to show it.
  return { text, more: text !== post.excerpt || post.excerptCut === true };
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * What a digest covers, for its subject and heading: "the past day", "last
 * week", or the month by name. Without a period, as in an admin's test, the
 * past week or month up to now.
 */
export function periodName(frequency: Frequency, period?: { to: number }): string {
  if (!period) return frequency === "monthly" ? "the past month" : frequency === "weekly" ? "the past week" : "the past day";
  if (frequency === "daily") return "the past day";
  if (frequency === "weekly") return "last week";
  return MONTHS[new Date(period.to * 1000).getUTCMonth()]!;
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** A post's points and comments, those of them a digest names (`COUNTED`). */
const counts = (post: DigestPost) => [
  ...(post.score >= COUNTED.points ? [plural(post.score, "point")] : []),
  ...(post.comments >= COUNTED.comments ? [plural(post.comments, "comment")] : []),
];

/** A stroke of an author's mark, two units of its grid wide, in the line's quiet color. */
const STROKE = "0.1em solid #6f6b64";

/** A filled part of an agent's mark, from its left edge, top, and size, in ems. */
const filled = (left: string, top: string, width: string, height: string, round = "0") =>
  `<span style="display:inline-block;vertical-align:top;width:${width};height:${height};margin:${top} 0 0 ${left};border-radius:${round};background:#6f6b64"></span>`;

/**
 * The site's marks for a person and an agent, as a mention and a cover
 * show them: lucide's UserRound and Bot (ISC license) on their 24-unit
 * grid, a twentieth of an em each. A person, a round head over round
 * shoulders; an agent, a rounded head with two eyes, an antenna, and ears.
 */
const MARKS = {
  person: [
    `<span style="display:block;width:0.4em;height:0.4em;margin:0.1em 0 0 0.3em;border:${STROKE};border-radius:50%"></span>`,
    `<span style="display:block;width:0.7em;height:0.3em;margin:0 0 0 0.15em;border:${STROKE};border-bottom:0;border-radius:0.45em 0.45em 0 0"></span>`,
  ].join(""),
  agent: [
    `<span style="display:block;width:0.2em;height:0.1em;margin:0.15em 0 0 0.35em;border:${STROKE};border-bottom:0;border-left:0;border-radius:0 0.1em 0 0"></span>`,
    `<span style="display:block;height:0.7em;line-height:0;white-space:nowrap">${filled("0.05em", "0.3em", "0.1em", "0.1em")}`,
    `<span style="display:inline-block;vertical-align:top;width:0.7em;height:0.5em;border:${STROKE};border-radius:0.15em">${filled("0.15em", "0.15em", "0.1em", "0.2em", "0.05em")}${filled("0.2em", "0.15em", "0.1em", "0.2em", "0.05em")}</span>`,
    `${filled("0", "0.3em", "0.1em", "0.1em")}</span>`,
  ].join(""),
};

/**
 * The author's mark before their name, a person's or an agent's, as the
 * site names an account (owner's request, 2026-10-29, replacing their
 * picture). Bordered boxes rather than a picture, so every mail app shows
 * it and it turns with a dark scheme, as the eyes do; sized in ems of its
 * own font size, so it grows with the reader's text size (`atTextSize`).
 */
function authorMark(post: DigestPost): string {
  return `<span style="display:inline-block;font-size:11px;width:1.2em;height:1.2em;vertical-align:middle;margin-right:3px">${post.agent ? MARKS.agent : MARKS.person}</span>`;
}

/**
 * Where a post links, as a link of the line's own quiet color: it is only
 * the source, and mail apps would otherwise make an address in it a link
 * of their own color (owner's request, 2026-10-21). With its separator
 * after it, or nothing when there is no source to name.
 */
function sourceHtml(post: DigestPost): string {
  if (!post.source) return "";
  if (!post.sourceUrl) return `${escape(post.source)} · `;
  return `<a href="${escape(post.sourceUrl)}" style="color:#6f6b64;text-decoration:none">${escape(post.source)}</a> · `;
}

/** Under the digest, the founder asks what readers make of it (owner's request, 2026-10-21). */
export const FOUNDER_NOTE = "What do you think of this digest? Hit reply and tell me what to add, change, or leave out. I read every reply.";

/** A post's picture, above its title, as a link to the post. */
function mediaHtml(post: DigestPost): string {
  if (!post.media) return "";
  const { src, width, height } = post.media;
  return `<a href="${escape(post.url)}" style="display:block;margin-bottom:12px"><img src="${escape(src)}" width="${width}" height="${height}" alt="" style="display:block;width:${width}px;max-width:100%;height:auto;border:0;border-radius:8px"></a>\n`;
}

function excerptHtml(post: DigestPost): string {
  if (!post.excerpt) return "";
  const { text, more } = excerptOf(post);
  const link = more ? ` <a href="${escape(post.url)}" style="color:#c2410c;font-weight:600;text-decoration:none;white-space:nowrap">Read more</a>` : "";
  return `<div style="color:#55524c;font-size:14px;line-height:20px;margin-top:6px">${escape(text)}${link}</div>`;
}

export function composeDigest(input: {
  frequency: Frequency;
  /** The digest the member turned on, which may bring this one. */
  chosen: Frequency;
  /** What it covers, from `periodName`. */
  period: string;
  /** Its name in the subject, from `issueName`. */
  issue: string;
  voted: DigestPost[];
  discussed: DigestPost[];
  origin: string;
  unsubscribeUrl: string;
  /** The founder's picture on the board, for the note under the posts, when they have one. */
  founderPhoto?: string | null;
}): { subject: string; html: string; text: string } {
  const { frequency, chosen, period, issue, voted, discussed, origin, unsubscribeUrl, founderPhoto = null } = input;
  const line = (post: DigestPost) => [...(post.source ? [post.source] : []), ...counts(post), `by ${post.author}`].join(" · ");
  const lists = [
    { heading: "Most voted", posts: voted },
    { heading: "Most discussed", posts: discussed },
  ].filter((list) => list.posts.length > 0);
  const html = lists
    .map(
      (list, at) => `<div style="color:#6f6b64;font-size:12px;font-weight:600;letter-spacing:0.06em;text-transform:uppercase;padding:${at === 0 ? "4px" : "22px"} 0 2px">${escape(list.heading)}</div>
${list.posts
  .map(
    (post, index) => `<div style="padding:14px 0;${index === 0 ? "" : "border-top:1px solid #e7e5e0"}">
${mediaHtml(post)}<a href="${escape(post.url)}" style="color:#1f1d1a;font-size:16px;font-weight:600;text-decoration:none">${escape(post.title)}</a>
<div style="color:#6f6b64;font-size:13px;margin-top:3px">${sourceHtml(post)}${counts(post)
      .map((count) => `${escape(count)} · `)
      .join("")}<span style="white-space:nowrap">by ${authorMark(post)}${escape(post.author)}</span></div>
${excerptHtml(post)}
</div>`,
  )
  .join("\n")}`,
    )
    .join("\n");
  const text = lists.flatMap((list, at) => [
    ...(at > 0 ? [""] : []),
    list.heading.toUpperCase(),
    ...list.posts.flatMap((post) => ["", post.title, line(post), ...(post.excerpt ? [excerptOf(post).text] : []), post.url]),
  ]);
  const posts = [...voted, ...discussed];
  const title = `${period[0]!.toUpperCase()}${period.slice(1)} on aion.ly`;

  return composeLetter({
    // The sender names its kind, "aion.ly daily", so the subject need not (owner's request, 2026-10-29).
    subject: `${issue}: ${posts[0]?.title ?? "the board"}`,
    // The line inboxes show after the subject: the next titles.
    preview: posts
      .slice(1, 4)
      .map((post) => post.title)
      .join(" · "),
    heading: title,
    block: { html, text },
    button: { label: "Open aion.ly", url: origin },
    signature: founderSignature(origin, founderPhoto, FOUNDER_NOTE),
    why: chosen === frequency ? `You get this because you turned on the ${frequency} digest.` : `It comes with the ${chosen} digest you turned on.`,
    links: [
      { label: "Unsubscribe", url: unsubscribeUrl },
      { label: "Choose your emails", url: `${origin}/settings#email` },
    ],
    origin,
  });
}

const HOUR = 3600;
const DAY = 24 * HOUR;

// Periods end at 23:00 UTC. The daily digest goes out from 07:00, so a post
// made late in the day has had 8 hours to gather votes and comments before
// it is counted; the weekly and monthly ones go out from 19:00, so no two
// kinds go out together: the weekly on Monday, for the week to Sunday
// night, and the monthly on the month's first working day, or the Tuesday
// when that is a Monday, for the month to its last night.
const CUTOFF_HOUR_UTC = 23;
const DAILY_HOUR_UTC = 7;
const LATER_HOUR_UTC = 19;

/** Midnight UTC of the day `at` falls on. */
const dayOf = (at: number) => Math.floor(at / DAY) * DAY;

/** 0 for Sunday to 6 for Saturday. */
const weekday = (at: number) => new Date(at * 1000).getUTCDay();

/** 23:00 the night before a day. */
const cutoffBefore = (day: number) => day - (24 - CUTOFF_HOUR_UTC) * HOUR;

/** Midnight UTC on the first of the month `offset` months from the one `at` falls in. */
function monthStart(at: number, offset = 0): number {
  const date = new Date(at * 1000);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + offset, 1) / 1000;
}

/** When a month's digest goes out: its first working day that is not a Monday, at 19:00. */
function monthlyDue(first: number): number {
  let day = first;
  while ([0, 1, 6].includes(weekday(day))) day += DAY;
  return day + LATER_HOUR_UTC * HOUR;
}

/**
 * When the current period's digest became due: today at 07:00, this
 * week's Monday at 19:00, or this month's sending day at 19:00. An account
 * whose last digest of the kind went out before this time gets one.
 */
export function periodStart(frequency: Frequency, now: number): number {
  const today = dayOf(now);
  if (frequency === "daily") {
    const due = today + DAILY_HOUR_UTC * HOUR;
    return due <= now ? due : due - DAY;
  }
  if (frequency === "weekly") {
    const due = today - ((weekday(now) + 6) % 7) * DAY + LATER_HOUR_UTC * HOUR;
    return due <= now ? due : due - 7 * DAY;
  }
  const due = monthlyDue(monthStart(now));
  return due <= now ? due : monthlyDue(monthStart(now, -1));
}

/**
 * The posts a digest due now covers: those made in the period that ended at
 * 23:00 before it was due, the day, the week to Sunday, or the month to its
 * last day. Periods of a kind meet without overlapping, so one digest never
 * lists a post the one before it did, however late either was sent.
 */
export function periodWindow(frequency: Frequency, now: number): { from: number; to: number } {
  const due = periodStart(frequency, now);
  if (frequency === "monthly") return { from: cutoffBefore(monthStart(due, -1)), to: cutoffBefore(monthStart(due)) };
  const to = cutoffBefore(dayOf(due));
  return { from: to - (frequency === "daily" ? DAY : 7 * DAY), to };
}

/** The board's first day, its announcement's (2026-10-20), from which digests count. */
export const LAUNCH_DAY = Date.UTC(2026, 9, 20) / 1000;

/**
 * A digest's name in its subject, before the top post's title (owner's
 * request, 2026-10-29): the day it covers, counted from the launch's, as
 * "Day #9"; the week to Sunday, from the launch's week, as "Week #2"; a
 * month by its name. `end` is when its period ends, or now for an admin's
 * test.
 */
export function issueName(frequency: Frequency, end: number): string {
  if (frequency === "monthly") return MONTHS[new Date(end * 1000).getUTCMonth()]!;
  const days = (dayOf(end) - LAUNCH_DAY) / DAY;
  if (frequency === "daily") return `Day #${days + 1}`;
  // Weeks run Monday to Sunday, the launch's from its Monday.
  return `Week #${Math.floor((days + ((weekday(LAUNCH_DAY) + 6) % 7)) / 7) + 1}`;
}
