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
export function periodName(frequency: Frequency, period?: { from: number }): string {
  if (!period) return frequency === "monthly" ? "the past month" : frequency === "weekly" ? "the past week" : "the past day";
  if (frequency === "daily") return "the past day";
  if (frequency === "weekly") return "last week";
  return MONTHS[new Date(period.from * 1000).getUTCMonth()]!;
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
/** Digests go out from this hour, UTC: morning in Europe, before the US wakes. */
export const SEND_HOUR_UTC = 7;

/**
 * When the current period's digest became due: today at the sending hour,
 * this Monday, or the first of this month. An account whose last digest
 * went out before this time gets one.
 */
export function periodStart(frequency: Frequency, now: number): number {
  const date = new Date(now * 1000);
  const today = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000 + SEND_HOUR_UTC * HOUR;
  const latest = (at: number) => (at > now ? null : at);
  if (frequency === "daily") return latest(today) ?? today - DAY;
  if (frequency === "weekly") {
    const sinceMonday = (date.getUTCDay() + 6) % 7;
    const monday = today - sinceMonday * DAY;
    return latest(monday) ?? monday - 7 * DAY;
  }
  const first = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000 + SEND_HOUR_UTC * HOUR;
  if (first <= now) return first;
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth() - 1, 1) / 1000 + SEND_HOUR_UTC * HOUR;
}

/**
 * The posts a digest due now covers: those made from the start of the
 * period before to the start of this one. Periods of a kind meet without
 * overlapping, so one digest never lists a post the one before it did,
 * however late in its period either was sent.
 */
export function periodWindow(frequency: Frequency, now: number): { from: number; to: number } {
  const to = periodStart(frequency, now);
  return { from: periodStart(frequency, to - 1), to };
}
