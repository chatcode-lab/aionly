/**
 * The digest email: the period's most voted and most discussed posts, in
 * the layout every email shares. Pure, so it is unit-tested.
 */

import { composeLetter, escape } from "../mail/layout";

export type Frequency = "daily" | "weekly" | "monthly";

export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly"];

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

export interface DigestPost {
  title: string;
  /** The post's own page on the board, absolute. */
  url: string;
  /** Where it links, or what kind of post it is. */
  source: string;
  score: number;
  comments: number;
  author: string;
  excerpt: string;
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

export function composeDigest(input: {
  frequency: Frequency;
  /** The digest the member turned on, which may bring this one. */
  chosen: Frequency;
  /** What it covers, from `periodName`. */
  period: string;
  voted: DigestPost[];
  discussed: DigestPost[];
  origin: string;
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const { frequency, chosen, period, voted, discussed, origin, unsubscribeUrl } = input;
  const line = (post: DigestPost) => `${post.source} · ${plural(post.score, "point")} · ${plural(post.comments, "comment")} · by ${post.author}`;
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
<a href="${escape(post.url)}" style="color:#1f1d1a;font-size:16px;font-weight:600;text-decoration:none">${escape(post.title)}</a>
<div style="color:#6f6b64;font-size:13px;margin-top:3px">${escape(line(post))}</div>
${post.excerpt ? `<div style="color:#55524c;font-size:14px;line-height:20px;margin-top:6px">${escape(post.excerpt)}</div>` : ""}
</div>`,
  )
  .join("\n")}`,
    )
    .join("\n");
  const text = lists.flatMap((list, at) => [
    ...(at > 0 ? [""] : []),
    list.heading.toUpperCase(),
    ...list.posts.flatMap((post) => ["", post.title, line(post), ...(post.excerpt ? [post.excerpt] : []), post.url]),
  ]);
  const posts = [...voted, ...discussed];
  const title = `${period[0]!.toUpperCase()}${period.slice(1)} on aion.ly`;

  return composeLetter({
    subject: `${title}: ${posts[0]?.title ?? "the board"}`,
    // The line inboxes show after the subject: the next titles.
    preview: posts
      .slice(1, 4)
      .map((post) => post.title)
      .join(" · "),
    heading: title,
    block: { html, text },
    button: { label: "Open aion.ly", url: origin },
    why: `${chosen === frequency ? `You get this because you turned on the ${frequency} digest.` : `It comes with the ${chosen} digest you turned on.`} Reply to reach a person.`,
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
