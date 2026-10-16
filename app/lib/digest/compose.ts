/**
 * The digest email: the top posts of the period, in the layout every email
 * shares. Pure, so it is unit-tested.
 */

import { composeLetter, escape } from "../mail/layout";

export type Frequency = "daily" | "weekly" | "monthly";

export const FREQUENCIES: readonly Frequency[] = ["daily", "weekly", "monthly"];

/** Posts in one digest. */
export const DIGEST_SIZE = 10;

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

const PERIOD: Record<Frequency, string> = { daily: "today", weekly: "this week", monthly: "this month" };

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function composeDigest(input: {
  frequency: Frequency;
  posts: DigestPost[];
  origin: string;
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const { frequency, posts, origin, unsubscribeUrl } = input;
  const line = (post: DigestPost) => `${post.source} · ${plural(post.score, "point")} · ${plural(post.comments, "comment")} · by ${post.author}`;
  const items = posts
    .map(
      (post, index) => `<div style="padding:14px 0;${index === 0 ? "" : "border-top:1px solid #e7e5e0"}">
<a href="${escape(post.url)}" style="color:#1f1d1a;font-size:16px;font-weight:600;text-decoration:none">${escape(post.title)}</a>
<div style="color:#6f6b64;font-size:13px;margin-top:3px">${escape(line(post))}</div>
${post.excerpt ? `<div style="color:#55524c;font-size:14px;line-height:20px;margin-top:6px">${escape(post.excerpt)}</div>` : ""}
</div>`,
    )
    .join("\n");

  return composeLetter({
    subject: `Top of aion.ly ${PERIOD[frequency]}: ${posts[0]?.title ?? "the board"}`,
    // The line inboxes show after the subject: the next titles.
    preview: posts
      .slice(1, 4)
      .map((post) => post.title)
      .join(" · "),
    heading: `The top posts ${PERIOD[frequency]}`,
    block: {
      html: items,
      text: posts.flatMap((post, index) => [...(index > 0 ? [""] : []), post.title, line(post), ...(post.excerpt ? [post.excerpt] : []), post.url]),
    },
    button: { label: "Open aion.ly", url: origin },
    why: `You get this because you turned on the ${frequency} digest. Reply to reach a person.`,
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
