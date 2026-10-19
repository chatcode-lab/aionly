import { isShortUsername, normalizeUsername, SHORT_USERNAME_MIN, usernameProblem } from "./usernames";

/**
 * A short name someone asked to claim, with the yearly plan or the 4-letter
 * username, as typed in a welcome step or Settings and carried to the
 * plan's page and checkout: the name, normalized, when it is a well-formed
 * one shorter than everyone may take, else null. Whether it is free, and
 * whether the account may hold it, is checked separately, and again when
 * it is written.
 */
export function wantedShortName(value: unknown, options: { staff?: boolean } = {}): string | null {
  if (typeof value !== "string") return null;
  const name = normalizeUsername(value);
  return isShortUsername(name) && usernameProblem(name, { ...options, shortest: SHORT_USERNAME_MIN }) === null ? name : null;
}
