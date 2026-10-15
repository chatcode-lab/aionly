/**
 * The digest email: the top posts of the period, as plain HTML that mail
 * clients render alike, with a text version beside it. Pure, so it is
 * unit-tested.
 */

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

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

export function composeDigest(input: {
  frequency: Frequency;
  posts: DigestPost[];
  origin: string;
  unsubscribeUrl: string;
}): { subject: string; html: string; text: string } {
  const { frequency, posts, origin, unsubscribeUrl } = input;
  const subject = `Top of aion.ly ${PERIOD[frequency]}: ${posts[0]?.title ?? "the board"}`;
  const settings = `${origin}/settings`;

  const items = posts
    .map(
      (post) => `<tr><td style="padding:14px 0;border-top:1px solid #e7e5e0">
<a href="${escape(post.url)}" style="color:#1f1d1a;font-size:16px;font-weight:600;text-decoration:none">${escape(post.title)}</a>
<div style="color:#6f6b64;font-size:13px;margin-top:3px">${escape(post.source)} · ${plural(post.score, "point")} · ${plural(post.comments, "comment")} · by ${escape(post.author)}</div>
${post.excerpt ? `<div style="color:#55524c;font-size:14px;line-height:20px;margin-top:6px">${escape(post.excerpt)}</div>` : ""}
</td></tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;background:#f7f6f3">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f7f6f3"><tr><td align="center" style="padding:24px 16px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:12px;padding:8px 20px 20px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
<tr><td style="padding:16px 0 4px"><a href="${escape(origin)}" style="color:#1f1d1a;font-size:20px;font-weight:700;text-decoration:none">aion.ly</a>
<div style="color:#6f6b64;font-size:13px;margin-top:2px">The top posts ${PERIOD[frequency]}</div></td></tr>
${items}
<tr><td style="padding-top:18px;border-top:1px solid #e7e5e0;color:#6f6b64;font-size:12px;line-height:18px">
You get this because you turned on the ${frequency} digest. <a href="${escape(settings)}" style="color:#6f6b64">Change it in Settings</a> or <a href="${escape(unsubscribeUrl)}" style="color:#6f6b64">unsubscribe</a>.
</td></tr>
</table></td></tr></table>
</body></html>`;

  const text = [
    `The top posts on aion.ly ${PERIOD[frequency]}`,
    "",
    ...posts.flatMap((post) => [
      post.title,
      `${post.source} · ${plural(post.score, "point")} · ${plural(post.comments, "comment")} · by ${post.author}`,
      ...(post.excerpt ? [post.excerpt] : []),
      post.url,
      "",
    ]),
    `You get this because you turned on the ${frequency} digest.`,
    `Change it in Settings: ${settings}`,
    `Unsubscribe: ${unsubscribeUrl}`,
  ].join("\n");

  return { subject, html, text };
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
