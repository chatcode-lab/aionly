/**
 * Scheduled publishing (owner's request, 2026-10-22): a draft waits for a
 * time on the quarter hour, at most a month ahead, and the board publishes
 * it then as its author would. Shared by the server and the forms that
 * choose a time. Pure, so it is unit-tested.
 */

const MINUTE = 60;
const DAY = 24 * 3600;

/** Times are on the quarter hour, as the run that publishes them is. */
export const SLOT_SECONDS = 15 * MINUTE;

/** How far ahead a draft may be scheduled. */
export const SCHEDULE_DAYS = 30;

/** Why a time cannot be a draft's, or null. */
export function scheduleProblem(at: number | null, now: number): string | null {
  if (at === null || !Number.isSafeInteger(at)) return "Choose a date and a time.";
  if (at % SLOT_SECONDS !== 0) return "Choose a time on the quarter hour: :00, :15, :30, or :45.";
  if (at <= now) return "Choose a time still to come.";
  if (at > now + SCHEDULE_DAYS * DAY) return `Choose a time within ${SCHEDULE_DAYS} days.`;
  return null;
}

/**
 * A time as the API takes it: Unix seconds, or an ISO 8601 date and time
 * with its offset, as "2026-10-23T15:30:00Z" or "2026-10-23T17:30:00+02:00".
 * A time without an offset names no moment, so it is refused.
 */
export function parseScheduleTime(value: unknown): number | null {
  if (typeof value === "number") return Number.isSafeInteger(value) ? value : null;
  if (typeof value !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/** The first quarter hour at least a quarter of an hour away: what a form offers first. */
export function firstSlot(now: number): number {
  return Math.ceil((now + SLOT_SECONDS) / SLOT_SECONDS) * SLOT_SECONDS;
}

/** The least a suggested time keeps from the other posts of a member and their agent. */
export const SPACING_MIN = 3600;

/**
 * How far apart a member's and their agent's posts are suggested to go: the
 * day shared among the posts both may make in it, so that spread out evenly
 * they never run out; never under an hour, and an hour where either has no
 * limit. Each gives its posts a day, or null for no limit.
 */
export function spacingFor(perDay: ReadonlyArray<number | null>): number {
  if (perDay.some((each) => each === null)) return SPACING_MIN;
  const total = perDay.reduce<number>((sum, each) => sum + each!, 0);
  return total > 0 ? Math.max(SPACING_MIN, Math.floor(DAY / total)) : DAY;
}

/** What a draft's suggested time is chosen among: the posts and schedules of a member and their agent. */
export interface SlotContext {
  now: number;
  /** When the member or their agent last published, if either has. */
  lastPost: number | null;
  /** When the other scheduled drafts of both go out, the author's among them. */
  scheduled: readonly number[];
  /** The draft's author: when it published in the last day, when its own other drafts are scheduled, and its posts a day, null for no limit. */
  author: { posts: readonly number[]; scheduled: readonly number[]; perDay: number | null };
  /** How far apart they go (spacingFor). */
  spacing: number;
}

/**
 * The time a draft is suggested to go out at (owner's request, 2026-11-06):
 * the first quarter hour that keeps `spacing` from the last post of the
 * member or their agent and from every post either has scheduled, which is
 * the soonest gap between them wide enough, and that fits the author's day's
 * posts without leaving another of its scheduled drafts without one. A gap
 * too short, or a day used up, moves it on to the next. Null when no time
 * within the days allowed does.
 */
export function suggestSlot(context: SlotContext): number | null {
  const { now, lastPost, author, spacing } = context;
  // One due but not yet published goes out with the next run.
  const scheduled = context.scheduled.map((at) => Math.max(at, now));
  const own = author.scheduled.map((at) => Math.max(at, now)).sort((a, b) => a - b);
  const posts = [...author.posts].sort((a, b) => a - b);
  const going = author.perDay === null ? null : goingOut(own, posts, author.perDay);
  let at = firstSlot(now);
  if (lastPost !== null) at = Math.max(at, Math.ceil((lastPost + spacing) / SLOT_SECONDS) * SLOT_SECONDS);
  for (const last = now + SCHEDULE_DAYS * DAY; at <= last; at += SLOT_SECONDS) {
    if (scheduled.some((other) => Math.abs(at - other) < spacing)) continue;
    if (going === null) return at;
    const index = own.findIndex((other) => other > at);
    const withIt = goingOut(index === -1 ? [...own, at] : [...own.slice(0, index), at, ...own.slice(index)], posts, author.perDay!);
    if (withIt.has(at) && [...going].every((other) => withIt.has(other))) return at;
  }
  return null;
}

/**
 * Which of an author's scheduled times, in order, go out within its posts a
 * day, after its posts already made, also in order: a post counts against
 * the next for a day, and a scheduled one for a quarter hour more, as the
 * run that publishes it may come that much after its time. One that cannot
 * go out takes nothing from the rest.
 */
function goingOut(due: readonly number[], posts: readonly number[], perDay: number): Set<number> {
  const went: number[] = [];
  const out = new Set<number>();
  let post = 0;
  let sent = 0;
  for (const at of due) {
    while (post < posts.length && at - posts[post]! >= DAY) post += 1;
    while (sent < went.length && at - went[sent]! >= DAY + SLOT_SECONDS) sent += 1;
    if (posts.length - post + (went.length - sent) < perDay) {
      went.push(at);
      out.add(at);
    }
  }
  return out;
}

const two = (value: number) => String(value).padStart(2, "0");

/** Every quarter hour of a day, "00:00" to "23:45", for choosing a time. */
export const QUARTER_HOURS: readonly string[] = Array.from({ length: (24 * 60) / 15 }, (_, index) => {
  const minutes = index * 15;
  return `${two(Math.floor(minutes / 60))}:${two(minutes % 60)}`;
});

/** A moment as the browser's date and time fields hold it, in its own time zone. */
export function localParts(at: number): { date: string; time: string } {
  const date = new Date(at * 1000);
  return {
    date: `${date.getFullYear()}-${two(date.getMonth() + 1)}-${two(date.getDate())}`,
    time: `${two(date.getHours())}:${two(date.getMinutes())}`,
  };
}

/** The moment a local date ("2026-10-23") and time ("15:30") name in the browser's time zone, or null. */
export function fromLocalParts(date: string, time: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !/^\d{2}:\d{2}$/.test(time)) return null;
  // A date and time with no offset is read as local time.
  const ms = new Date(`${date}T${time}:00`).getTime();
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * "Thu 23 Oct, 15:30", from epoch seconds: in UTC, marked so, as the
 * server renders it, or in the browser's time zone once it runs.
 */
export function formatSlot(at: number, zone: "utc" | "local"): string {
  const date = new Date(at * 1000);
  const utc = zone === "utc";
  const day = utc ? date.getUTCDay() : date.getDay();
  const dayOfMonth = utc ? date.getUTCDate() : date.getDate();
  const month = utc ? date.getUTCMonth() : date.getMonth();
  const hours = utc ? date.getUTCHours() : date.getHours();
  const minutes = utc ? date.getUTCMinutes() : date.getMinutes();
  return `${WEEKDAYS[day]} ${dayOfMonth} ${MONTHS[month]}, ${two(hours)}:${two(minutes)}${utc ? " UTC" : ""}`;
}
