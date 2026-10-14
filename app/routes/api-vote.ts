import { env } from "cloudflare:workers";

import { castVote, type TargetType, type VoteValue } from "~/lib/db/votes.server";
import { readSmallJson, ROW_ID } from "~/lib/security/body";
import { rateLimited, withinLimits } from "~/lib/security/rate-limit.server";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/api-vote";

const REFUSAL = {
  own: "You can't vote on your own posts or comments.",
  closed: "This no longer takes votes.",
  not_allowed: "Your account can't vote.",
  not_found: "That is no longer here.",
} as const;

/**
 * Sets, changes, or clears the signed-in account's vote on a post or a
 * comment. Answers with the item's new score and the vote as stored.
 */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "vote", viewer.id))) return rateLimited();
  const body = (await readSmallJson(request)) as
    | { type?: unknown; id?: unknown; value?: unknown }
    | undefined;

  const type = body?.type;
  const id = body?.id;
  const value = body?.value;
  if (
    (type !== "post" && type !== "comment") ||
    typeof id !== "string" ||
    !ROW_ID.test(id) ||
    (value !== -1 && value !== 0 && value !== 1)
  ) {
    return Response.json({ error: "invalid", message: "That vote was not understood." }, { status: 400 });
  }

  const result = await castVote(env.DB, {
    voterId: viewer.id,
    type: type as TargetType,
    targetId: id,
    value: value as VoteValue,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    return Response.json(
      { error: result.reason, message: REFUSAL[result.reason] },
      { status: result.reason === "not_found" ? 404 : 403 },
    );
  }
  return Response.json({ score: result.score, vote: result.vote });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
