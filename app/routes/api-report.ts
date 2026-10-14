import { env } from "cloudflare:workers";

import { waitUntilContext } from "~/context";
import { fileReport } from "~/lib/db/reports.server";
import { newId } from "~/lib/ids";
import { NOTE_MAX, REASON_LABEL, REASONS, type ReportReason, type ReportTarget } from "~/lib/reports";
import { readSmallJson, ROW_ID } from "~/lib/security/body";
import { rateLimited, withinLimits } from "~/lib/security/rate-limit.server";
import { length } from "~/lib/submit/rules";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/api-report";

const REFUSAL = {
  not_found: "That is no longer here to report.",
  own: "You can't report yourself or your own posts and comments.",
  limit: "That is 20 reports in a day. Moderators will get to them; try again tomorrow.",
  not_allowed: "Your account can't report.",
} as const;

/**
 * Announces a new report to the moderators' channel, if one is set up:
 * what kind of thing and why, and where the queue is. Never who reported
 * it or what it says.
 */
async function announce(url: string, report: { type: ReportTarget; reason: ReportReason; queue: string }) {
  const text = `New report: a ${report.type}, "${REASON_LABEL[report.reason]}". Queue: ${report.queue}`;
  await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    // `text` suits Slack and most services; `content` suits Discord.
    body: JSON.stringify({ text, content: text, target_type: report.type, reason: report.reason, queue: report.queue }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});
}

/** Files a report about a post, a comment, or a user. */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return rateLimited();

  const body = (await readSmallJson(request, 4096)) as
    | { type?: unknown; id?: unknown; reason?: unknown; note?: unknown }
    | undefined;
  const type = body?.type as ReportTarget;
  const reason = body?.reason as ReportReason;
  const note = typeof body?.note === "string" ? body.note.trim() : "";
  if (
    typeof type !== "string" ||
    !Object.hasOwn(REASONS, type) ||
    typeof body?.id !== "string" ||
    !ROW_ID.test(body.id) ||
    !REASONS[type].includes(reason) ||
    length(note) > NOTE_MAX
  ) {
    return Response.json({ error: "invalid", message: "That report was not understood." }, { status: 400 });
  }

  const result = await fileReport(env.DB, {
    id: newId(),
    reporterId: viewer.id,
    type,
    targetId: body.id,
    reason,
    note: note || null,
    now: Math.floor(Date.now() / 1000),
  });
  if (!result.ok) {
    return Response.json(
      { error: result.reason, message: REFUSAL[result.reason] },
      { status: result.reason === "not_found" ? 404 : result.reason === "limit" ? 429 : 403 },
    );
  }
  if (!result.existing && env.REPORT_WEBHOOK_URL) {
    const queue = `${new URL(request.url).origin}/admin`;
    context.get(waitUntilContext)(announce(env.REPORT_WEBHOOK_URL, { type, reason, queue }));
  }
  return Response.json({ existing: result.existing });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
