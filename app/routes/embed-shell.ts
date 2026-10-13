import { nonceContext } from "~/context";
import { isShellProvider } from "~/lib/embeds/frames";
import { isShellId, shellDocument } from "~/lib/embeds/shell";
import { buildShellPolicy, createNonce } from "~/lib/security/csp";

import type { Route } from "./+types/embed-shell";

/**
 * The embed shell: the fallback for a provider whose post only renders
 * through its own script. It never reads the session and renders from the
 * validated provider ID alone. It answers with its own sandboxing policy, the
 * one response the Worker does not give the site policy.
 */
export function loader({ params, request, context }: Route.LoaderArgs) {
  const { provider, id } = params;
  if (!isShellProvider(provider) || !isShellId(provider, id)) {
    throw new Response("Not Found", { status: 404 });
  }

  const url = new URL(request.url);
  const nonce = context.get(nonceContext) ?? createNonce();

  return new Response(
    shellDocument({
      provider,
      id,
      nonce,
      siteOrigin: url.origin,
      theme: url.searchParams.get("theme") === "dark" ? "dark" : "light",
    }),
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Content-Security-Policy": buildShellPolicy({
          nonce,
          siteOrigin: url.origin,
          provider,
        }),
        "Cache-Control": "no-store",
      },
    },
  );
}
