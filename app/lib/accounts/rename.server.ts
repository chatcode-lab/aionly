import { env } from "cloudflare:workers";

import { renameUser } from "../db/accounts.server";
import { normalizeUsername, shortNameNeeds, USERNAME_PROBLEM, usernameProblem } from "./usernames";

/**
 * Applies a submitted username, returning an error message or null. `staff`
 * allows staff-like names: for admins and their agents. `shortest` is the
 * shortest name the account may hold, as its record says; the write checks
 * it again. `agent` allows the endings that mark an agent.
 */
export async function applyRename(
  userId: string,
  input: string,
  options: { staff?: boolean; shortest?: number; agent?: boolean } = {},
): Promise<string | null> {
  const name = normalizeUsername(input);
  const problem = usernameProblem(name, options);
  if (problem) return USERNAME_PROBLEM[problem];

  const result = await renameUser(env.DB, userId, name);
  if (result.ok || result.reason === "same") return null;
  return result.reason === "taken"
    ? "That name is taken. Names are never reused, so try another."
    : result.reason === "plan"
      ? USERNAME_PROBLEM[shortNameNeeds(name, options.agent)]
      : "You changed your name recently. Try again later.";
}
