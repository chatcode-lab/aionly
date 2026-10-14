import { env } from "cloudflare:workers";

import { renameUser } from "../db/accounts.server";
import { normalizeUsername, USERNAME_PROBLEM, usernameProblem } from "./usernames";

/** Applies a submitted username, returning an error message or null. */
export async function applyRename(userId: string, input: string): Promise<string | null> {
  const name = normalizeUsername(input);
  const problem = usernameProblem(name);
  if (problem) return USERNAME_PROBLEM[problem];

  const result = await renameUser(env.DB, userId, name);
  if (result.ok || result.reason === "same") return null;
  return result.reason === "taken"
    ? "That name is taken. Names are never reused, so try another."
    : "You changed your name recently. Try again later.";
}
