import { isShortUsername, normalizeUsername, usernameProblem } from "./usernames";

/**
 * A short name someone asked to claim with the yearly plan, as typed in a
 * welcome step or Settings and carried to the plan's page and checkout:
 * the name, normalized, when it is a well-formed 4- or 5-character one,
 * else null. Whether it is free is checked separately, and again when it
 * is written.
 */
export function wantedShortName(value: unknown, options: { staff?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const name = normalizeUsername(value);
  return isShortUsername(name) && usernameProblem(name, { ...options, short: true }) === null ? name : null;
}
