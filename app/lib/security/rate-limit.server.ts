import { env } from "cloudflare:workers";

/** The kinds of action with their own burst limits; see the plan's table. */
export type LimitKind = "vote" | "comment" | "write" | "signin";

function limiters(kind: LimitKind): { account?: RateLimit; address: RateLimit } {
  switch (kind) {
    case "vote":
      return { account: env.RL_VOTE_USER, address: env.RL_VOTE_IP };
    case "comment":
      return { account: env.RL_COMMENT_USER, address: env.RL_COMMENT_IP };
    case "write":
      return { account: env.RL_WRITE_USER, address: env.RL_WRITE_IP };
    case "signin":
      return { address: env.RL_SIGNIN_IP };
  }
}

/**
 * The address a request is limited by: Cloudflare's own record of the
 * client, with IPv6 reduced to its /64, since one household or phone holds
 * a whole range. Null on the local machine, which only tests use.
 */
export function addressOf(request: Request): string | null {
  const ip = request.headers.get("CF-Connecting-IP");
  if (!ip || ip === "127.0.0.1" || ip === "::1") return null;
  // IPv4, including when written in IPv6 form.
  if (ip.includes(".")) return ip.slice(ip.lastIndexOf(":") + 1);
  const [head = "", tail = ""] = ip.split("::");
  const front = head ? head.split(":") : [];
  const back = tail ? tail.split(":") : [];
  const groups = [...front, ...Array(Math.max(0, 8 - front.length - back.length)).fill("0"), ...back];
  return `${groups.slice(0, 4).map((group) => group.toLowerCase().replace(/^0+(?=.)/, "")).join(":")}::/64`;
}

/** A keyed hash of an address, so the limiter never holds raw addresses. */
async function addressKey(address: string): Promise<string> {
  const data = new TextEncoder().encode(`rate-limit:${env.BETTER_AUTH_SECRET}:${address}`);
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", data));
  return [...digest.slice(0, 16)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/**
 * Whether a burst of this kind of action is still allowed, per account and
 * per address. Approximate and per Cloudflare location by design; what must
 * hold exactly, such as one vote per account or the posting allowance, is
 * kept in the database.
 */
export async function withinLimits(request: Request, kind: LimitKind, accountId: string | null): Promise<boolean> {
  const { account, address } = limiters(kind);
  const checks: Array<Promise<{ success: boolean }>> = [];
  if (account && accountId) checks.push(account.limit({ key: accountId }));
  const where = addressOf(request);
  if (where) checks.push(address.limit({ key: await addressKey(where) }));
  const results = await Promise.all(checks);
  return results.every((result) => result.success);
}

export const RATE_LIMITED_MESSAGE = "That was a lot at once. Wait a minute, then try again.";

/** The answer to a request over its limit, with when to try again. */
export function rateLimited(): Response {
  return Response.json(
    { error: "rate_limited", message: RATE_LIMITED_MESSAGE },
    { status: 429, headers: { "Retry-After": "60" } },
  );
}
