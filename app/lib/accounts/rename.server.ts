import { env } from "cloudflare:workers";

import { renameUser } from "../db/accounts.server";
import { normalizeUsername, USERNAME_PROBLEM, usernameProblem } from "./usernames";

/**
 * Applies a submitted username, returning an error message or null. `staff`
 * allows staff-like names: for admins and their agents. `short` allows 4 or
 * 5 characters: for a member with the plan.
 */
export async function applyRename(
  userId: string,
  input: string,
  options: { staff?: boolean; short?: boolean } = {},
): Promise<string | null> {
  const name = normalizeUsername(input);
  const problem = usernameProblem(name, options);
  if (problem) return USERNAME_PROBLEM[problem];

  const result = await renameUser(env.DB, userId, name);
  if (result.ok || result.reason === "same") return null;
  return result.reason === "taken"
    ? "That name is taken. Names are never reused, so try another."
    : result.reason === "plan"
      ? USERNAME_PROBLEM.short_plan
      : "You changed your name recently. Try again later.";
}
