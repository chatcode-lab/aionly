/**
 * The operator's notices of what happens on the board (owner's request,
 * 2026-11-03): sign-ups, payments and refunds, reports, deleted accounts,
 * and errors, posted by the channel's bot to a topic of the operator's
 * private group, each environment's to its own. Unset, nothing is sent. A
 * notice never holds up or fails what it tells of: it goes after the
 * answer, and one Telegram refuses is only logged. Never log an address of
 * the Bot API, which holds the token.
 */

import { env, waitUntil } from "cloudflare:workers";

import type { PaymentKind } from "../db/payments.server";

export interface Notice {
  icon: string;
  title: string;
  /** Each a label and its value, as Telegram's HTML; an empty label sets the value on a line of its own, and an empty value drops the line. */
  lines: Array<[label: string, html: string | null | undefined]>;
}

export interface EventBot {
  token: string;
  /** The group, as the Bot API wants it. */
  chat: string;
  /** Its topic; none for the General topic, which takes no thread ID. */
  topic: number | null;
}

/** How long one error stays quiet after its notice, counting its repeats for the next. */
const QUIET_MS = 15 * 60_000;
/** The most errors one instance remembers for that. */
const QUIET_KEYS = 100;
/** Telegram takes 4096 characters; an error's own text gets this many. */
const ERROR_TEXT = 600;
const STACK_LINES = 4;
const TIMEOUT = 10_000;

/** The group's ID as the Bot API wants it: Telegram's apps show a supergroup's without the -100. */
const chatOf = (group: string) => (/^\d+$/.test(group) ? `-100${group}` : group);

/** The bot and group for notices, where they are set up. */
export function eventBot(
  vars: { TELEGRAM_BOT_TOKEN?: string; TELEGRAM_EVENT_GROUP_ID?: string; TELEGRAM_EVENT_TOPIC_ID?: string } = env,
): EventBot | null {
  const token = vars.TELEGRAM_BOT_TOKEN?.trim();
  const group = vars.TELEGRAM_EVENT_GROUP_ID?.trim();
  if (!token || !group) return null;
  const topic = Number(vars.TELEGRAM_EVENT_TOPIC_ID?.trim() || NaN);
  return { token, chat: chatOf(group), topic: Number.isSafeInteger(topic) && topic > 1 ? topic : null };
}

export const escapeHtml = (text: string) => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** A notice as the message's HTML: its icon and title in bold, then a line for each value. */
export function noticeHtml(notice: Notice): string {
  const lines = notice.lines.filter(([, value]) => value).map(([label, value]) => (label ? `${escapeHtml(label)}: ${value}` : value!));
  return [`${notice.icon} <b>${escapeHtml(notice.title)}</b>`, ...lines].join("\n");
}

/** Hides the token, and anything else that looks like a secret, from what is logged or sent. */
export function redact(text: string, token?: string): string {
  const hidden = token ? text.split(token).join("<token>") : text;
  return hidden
    .replace(/bot\d+:[A-Za-z0-9_-]{20,}/g, "bot<token>")
    .replace(/\b(sk|rk|pk)_(live|test)_[A-Za-z0-9]+/g, "$1_$2_<hidden>")
    .replace(/\bwhsec_[A-Za-z0-9]+/g, "whsec_<hidden>");
}

/** Sends a notice. Whether Telegram took it; a refusal or no answer is logged, never thrown. */
export async function sendNotice(bot: EventBot, notice: Notice): Promise<boolean> {
  try {
    const response = await fetch(`https://api.telegram.org/bot${bot.token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: bot.chat,
        ...(bot.topic ? { message_thread_id: bot.topic } : {}),
        text: noticeHtml(notice),
        parse_mode: "HTML",
        link_preview_options: { is_disabled: true },
      }),
      signal: AbortSignal.timeout(TIMEOUT),
    });
    const answer = (await response.json()) as { ok: boolean; error_code?: number; description?: string };
    if (!answer.ok) console.error("event notice refused", notice.title, answer.error_code, answer.description);
    return answer.ok;
  } catch (error) {
    // A failed request can name its address.
    console.error("event notice not sent", notice.title, redact(String(error), bot.token));
    return false;
  }
}

/**
 * Sends the notice `make` gives, after the answer, where notices are set
 * up; `make` runs only then, so the reads it needs cost nothing otherwise.
 */
export function announce(make: () => Notice | null | Promise<Notice | null>): void {
  const bot = eventBot();
  if (!bot) return;
  const work = (async () => {
    try {
      const notice = await make();
      if (notice) await sendNotice(bot, notice);
    } catch (error) {
      console.error("event notice", redact(String(error), bot.token));
    }
  })();
  waitUntil(work);
}

const origin = () => env.SITE_ORIGIN || "https://aion.ly";

/** An account as a notice names it: its username, linked to its profile, and its ID. */
async function member(db: D1Database, userId: string): Promise<string> {
  const row = await db
    .prepare(`SELECT name FROM usernames WHERE user_id = ?1 AND is_current = 1`)
    .bind(userId)
    .first<{ name: string }>();
  const id = `<code>${escapeHtml(userId)}</code>`;
  if (!row) return id;
  return `<a href="${escapeHtml(`${origin()}/@${encodeURIComponent(row.name)}`)}">@${escapeHtml(row.name)}</a> · ${id}`;
}

const money = (cents: number, currency: string) => {
  try {
    return new Intl.NumberFormat("en-US", { style: "currency", currency: currency.toUpperCase() }).format(cents / 100);
  } catch {
    return `${(cents / 100).toFixed(2)} ${currency.toUpperCase()}`;
  }
};

const day = (seconds: number) =>
  new Date(seconds * 1000).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" });

const ordinal = (n: number) => {
  const tens = n % 100;
  const suffix = tens >= 11 && tens <= 13 ? "th" : ({ 1: "st", 2: "nd", 3: "rd" } as Record<number, string>)[n % 10] ?? "th";
  return `${n}${suffix}`;
};

/**
 * A new account, once its sign-up has run: who it is, its sign-in email,
 * how it came, and the digest it chose on the way in. What a failed step
 * left out is left out here too.
 */
export function announceSignUp(db: D1Database, userId: string): void {
  announce(async () => {
    const row = await db
      .prepare(
        `SELECT u.email, u."signupDigest" AS digest, partner.code AS partner, inviter.name AS inviter
         FROM "user" AS u
         LEFT JOIN profiles AS p ON p.user_id = u.id
         LEFT JOIN partner_joins AS partner ON partner.user_id = u.id
         LEFT JOIN usernames AS inviter ON inviter.user_id = p.invited_by AND inviter.is_current = 1
         WHERE u.id = ?1`,
      )
      .bind(userId)
      .first<{ email: string; digest: string | null; partner: string | null; inviter: string | null }>();
    const inviter = row?.inviter ? `<a href="${escapeHtml(`${origin()}/@${encodeURIComponent(row.inviter)}`)}">@${escapeHtml(row.inviter)}</a>` : null;
    const joined = row?.partner
      ? `the link <code>/join/${escapeHtml(row.partner)}</code>`
      : inviter
        ? `an invitation from ${inviter}`
        : "open sign-up";
    return {
      icon: "👤",
      title: "New member",
      lines: [
        ["User", await member(db, userId)],
        ["Method", "Google"],
        ["Email", row ? escapeHtml(row.email) : null],
        ["Joined with", joined],
        ["Digest", row?.digest],
      ],
    };
  });
}

const PAYMENT_TITLE: Record<PaymentKind, string> = {
  plan: "Fan plan payment",
  fresh_start: "Fresh start payment",
  name: "Short username payment",
};

/**
 * A payment recorded for the first time, before tax: for the plan, its
 * interval, how far it is paid, and how many the member has made; for a
 * short username, its length.
 */
export function announcePayment(
  db: D1Database,
  payment: { userId: string; kind: PaymentKind; cents: number; currency: string; paidUntil?: number | null; length?: number },
): void {
  announce(async () => {
    const lines: Notice["lines"] = [
      ["User", await member(db, payment.userId)],
      ["Payment", `${money(payment.cents, payment.currency)} before tax`],
    ];
    if (payment.kind === "plan") {
      const plan = await db
        .prepare(
          `SELECT s.interval, s.period_end, (SELECT COUNT(*) FROM payments WHERE user_id = ?1 AND kind = 'plan') AS paid
           FROM profiles AS p LEFT JOIN subscriptions AS s ON s.user_id = p.user_id WHERE p.user_id = ?1`,
        )
        .bind(payment.userId)
        .first<{ interval: string | null; period_end: number | null; paid: number }>();
      const until = payment.paidUntil ?? plan?.period_end;
      lines.push(
        ["Interval", plan?.interval === "year" ? "yearly" : plan?.interval === "month" ? "monthly" : null],
        ["Access until", until ? day(until) : null],
        ["Count", plan?.paid ? (plan.paid === 1 ? "first payment" : `${ordinal(plan.paid)} payment`) : null],
      );
    }
    if (payment.kind === "name" && payment.length) lines.push(["Length", `${payment.length} characters`]);
    return { icon: "💳", title: PAYMENT_TITLE[payment.kind], lines };
  });
}

/** Money given back, tax included, newly refunded on a charge, with what it paid for when the board knows. */
export function announceRefund(
  db: D1Database,
  refund: { chargeId: string; paymentIntent: string; invoiceId: string | null; cents: number; paid: number; currency: string },
): void {
  announce(async () => {
    const payment = await db
      .prepare(`SELECT user_id, kind FROM payments WHERE payment_intent = ?1 OR id = ?2 ORDER BY paid_at LIMIT 1`)
      .bind(refund.paymentIntent, refund.invoiceId)
      .first<{ user_id: string; kind: PaymentKind }>();
    return {
      icon: "↩️",
      title: "Refund",
      lines: [
        ["User", payment ? await member(db, payment.user_id) : null],
        ["For", payment ? PAYMENT_TITLE[payment.kind].replace(/ payment$/, "") : `charge <code>${escapeHtml(refund.chargeId)}</code>`],
        ["Refunded", `${money(refund.cents, refund.currency)} of ${money(refund.paid, refund.currency)}, tax included`],
      ],
    };
  });
}

/** Recent errors, by where and what, so one that repeats is told once a quarter hour. Per instance. */
const quiet = new Map<string, { until: number; repeats: number }>();

/** What an error says, without secrets, cut to fit: its first line, and where in the code. */
function describe(error: unknown, token?: string): { text: string; stack: string | null } {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  const frames =
    error instanceof Error && error.stack
      ? error.stack
          .split("\n")
          .filter((line) => /^\s+at /.test(line))
          .slice(0, STACK_LINES)
          .map((line) => line.trim())
      : [];
  const cut = (value: string, most: number) => (value.length > most ? `${value.slice(0, most - 1)}…` : value);
  return { text: cut(redact(text, token), ERROR_TEXT), stack: frames.length ? cut(redact(frames.join("\n"), token), ERROR_TEXT) : null };
}

/**
 * An error the operator should know of: where it happened (a request's
 * method and path, never its query, or the job's name) and what it says.
 * The same error again within a quarter hour is counted rather than sent,
 * and the count goes with the next notice of it.
 */
export function announceError(where: string, error: unknown, now = Date.now()): void {
  const bot = eventBot();
  if (!bot) return;
  const { text, stack } = describe(error, bot.token);
  const key = `${where}\n${text}`;
  const last = quiet.get(key);
  if (last && now < last.until) {
    last.repeats += 1;
    return;
  }
  quiet.delete(key);
  if (quiet.size >= QUIET_KEYS) {
    for (const [old, entry] of quiet) if (now >= entry.until) quiet.delete(old);
    if (quiet.size >= QUIET_KEYS) quiet.delete(quiet.keys().next().value!);
  }
  quiet.set(key, { until: now + QUIET_MS, repeats: 0 });
  const repeats = last?.repeats ?? 0;
  announce(() => ({
    icon: "🚨",
    title: "Error",
    lines: [
      ["Where", `<code>${escapeHtml(where)}</code>`],
      ["Error", `<code>${escapeHtml(text)}</code>`],
      ["", stack ? `<pre>${escapeHtml(stack)}</pre>` : null],
      ["Repeats", repeats ? `${repeats} more in the quarter hour before` : null],
    ],
  }));
}

/** Forgets the errors told of, for tests. */
export function forgetErrors(): void {
  quiet.clear();
}
