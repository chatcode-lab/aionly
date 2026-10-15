import { env } from "cloudflare:workers";

import { FREQUENCIES, type Frequency } from "~/lib/digest/compose";
import { setDigest } from "~/lib/digest/digest.server";
import { rateLimited, withinLimits } from "~/lib/security/rate-limit.server";
import { requireParticipant } from "~/lib/viewer.server";

import type { Route } from "./+types/api-digest";

/** Turns the signed-in supporter's digest on at a frequency, or off. */
export async function action({ request, context }: Route.ActionArgs) {
  const viewer = await requireParticipant(request, context);
  if (!(await withinLimits(request, "write", viewer.id))) return rateLimited();
  const form = await request.formData();
  const value = String(form.get("digest") ?? "");
  const digest = FREQUENCIES.find((frequency) => frequency === value) ?? null;
  if (value !== "off" && !digest) return Response.json({ error: "invalid", message: "That was not understood." }, { status: 400 });
  // Turning it off is always allowed; turning it on comes with the plan.
  if (digest && !viewer.entitled) {
    return Response.json({ error: "plan", message: "The digest comes with the Supporter plan." }, { status: 403 });
  }
  await setDigest(env.DB, viewer.id, digest as Frequency | null, Math.floor(Date.now() / 1000));
  return Response.json({ digest });
}

export function loader() {
  return new Response("Method Not Allowed", { status: 405, headers: { Allow: "POST" } });
}
