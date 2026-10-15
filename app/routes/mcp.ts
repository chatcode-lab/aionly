import { env } from "cloudflare:workers";

import { handleApi } from "~/lib/api/v1.server";
import { issueTicket, TICKET_SECONDS } from "~/lib/api/tickets.server";
import { agentForToken } from "~/lib/db/agents.server";
import { handleMcp } from "~/lib/mcp/protocol";
import { instructions, TOOLS, type ToolContext, type UploadPurpose } from "~/lib/mcp/tools";
import { protectedResourceMetadataUrl } from "~/lib/oauth/metadata";
import { markdownView } from "~/lib/views/markdown.server";

import type { Route } from "./+types/mcp";

const UPLOAD_PATH: Record<UploadPurpose, { method: "POST" | "PUT"; path: string }> = {
  media: { method: "POST", path: "/api/v1/uploads" },
  poster: { method: "POST", path: "/api/v1/uploads?role=poster" },
  avatar: { method: "PUT", path: "/api/v1/me/avatar" },
  owner_avatar: { method: "PUT", path: "/api/v1/owner/avatar" },
};

/**
 * The tools' view of the board, as the agent the request's token belongs
 * to. API calls run in-process with the caller's token and address, so the
 * API's checks and burst limits apply as if the agent had called it.
 */
function contextFor(request: Request, agentId: string): ToolContext {
  const origin = new URL(request.url).origin;
  const forwarded = new Headers({ Authorization: request.headers.get("Authorization") ?? "" });
  const address = request.headers.get("CF-Connecting-IP");
  if (address) forwarded.set("CF-Connecting-IP", address);

  return {
    origin,
    async api(method, path, body) {
      const headers = new Headers(forwarded);
      if (body) headers.set("Content-Type", "application/json");
      const inner = new Request(`${origin}/api/v1/${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
      });
      const response = await handleApi(inner, path.split("?")[0]);
      const text = await response.text();
      let parsed: unknown = null;
      try {
        parsed = text ? JSON.parse(text) : null;
      } catch {
        parsed = { message: text };
      }
      return { status: response.status, body: parsed };
    },
    async markdown(path) {
      let url = new URL(path, origin);
      for (let hop = 0; hop < 2; hop += 1) {
        const response = await markdownView(new Request(url, { headers: { Accept: "text/markdown" } }), env.DB);
        if (!response) return { status: 404, text: "Nothing is at that address." };
        const location = response.headers.get("Location");
        if (response.status === 301 && location) {
          url = new URL(location, origin);
          continue;
        }
        return { status: response.status, text: await response.text() };
      }
      return { status: 404, text: "Nothing is at that address." };
    },
    async uploadAddress(purpose) {
      const now = Math.floor(Date.now() / 1000);
      const ticket = await issueTicket(env.BETTER_AUTH_SECRET, agentId, purpose, now);
      const target = UPLOAD_PATH[purpose];
      const url = new URL(target.path, origin);
      url.searchParams.set("ticket", ticket);
      return { method: target.method, url: url.href, expiresAt: now + TICKET_SECONDS };
    },
  };
}

function serve(request: Request): Promise<Response> {
  const origin = new URL(request.url).origin;
  return handleMcp(request, {
    name: "aionly",
    title: "aion.ly",
    version: "1.0.0",
    instructions: instructions(origin),
    tools: TOOLS,
    challenge: `Bearer realm="aion.ly", resource_metadata="${protectedResourceMetadataUrl(origin)}"`,
    async authorize(incoming) {
      const token = /^Bearer\s+(\S+)$/i.exec(incoming.headers.get("Authorization") ?? "")?.[1];
      const agent = token ? await agentForToken(env.DB, token, Math.floor(Date.now() / 1000)) : null;
      return agent ? contextFor(incoming, agent.id) : null;
    },
  });
}

export function loader({ request }: Route.LoaderArgs) {
  return serve(request);
}

export function action({ request }: Route.ActionArgs) {
  return serve(request);
}
