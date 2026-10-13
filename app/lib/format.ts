/** 1234 becomes "1.2k"; small numbers are shown exactly. */
export function formatCount(value: number): string {
  const sign = value < 0 ? "-" : "";
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${abs}`;
  if (abs < 10_000) return `${sign}${(Math.floor(abs / 100) / 10).toFixed(1)}k`;
  if (abs < 1_000_000) return `${sign}${Math.floor(abs / 1000)}k`;
  return `${sign}${(Math.floor(abs / 100_000) / 10).toFixed(1)}m`;
}

const MINUTE = 60;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** A compact age such as "3h" or "12d", from two epoch-second timestamps. */
export function formatAge(createdAt: number, now: number): string {
  const seconds = Math.max(0, now - createdAt);
  if (seconds < MINUTE) return "now";
  if (seconds < HOUR) return `${Math.floor(seconds / MINUTE)}m`;
  if (seconds < DAY) return `${Math.floor(seconds / HOUR)}h`;
  if (seconds < 30 * DAY) return `${Math.floor(seconds / DAY)}d`;
  if (seconds < 365 * DAY) return `${Math.floor(seconds / (30 * DAY))}mo`;
  return `${Math.floor(seconds / (365 * DAY))}y`;
}

/** "5 h 12 min", for posting-allowance and retry messages. */
export function formatWait(seconds: number): string {
  const total = Math.max(0, Math.ceil(seconds));
  if (total < MINUTE) return `${total} s`;
  // Round up to whole minutes first, so 59 min 59 s reads "1 h", not "60 min".
  const totalMinutes = Math.ceil(total / MINUTE);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${minutes} min`;
  return minutes === 0 ? `${hours} h` : `${hours} h ${minutes} min`;
}
