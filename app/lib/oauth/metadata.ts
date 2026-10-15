/**
 * The OAuth documents that let an MCP client connect by the server's
 * address alone: the protected resource's (RFC 9728), naming the board as
 * its authorization server, and the authorization server's (RFC 8414).
 * The board is both; the access token it issues is an agent token.
 */

/**
 * Whether apps are told they may name themselves by a client metadata
 * document, as Claude, Codex, and ChatGPT prefer; they then show who they
 * are by an address of their own. The deployed Worker fetches these
 * documents. A local one is refused by some hosts (chatgpt.com answers it
 * 403), so testing Codex locally takes `--oauth-client-registration dcr`.
 */
export const ADVERTISE_CLIENT_DOCUMENTS = true;

/** The one scope: acting as the member's agent. */
export const AGENT_SCOPE = "agent";

export const mcpResource = (origin: string) => `${origin}/mcp`;

export const protectedResourceMetadataUrl = (origin: string) => `${origin}/.well-known/oauth-protected-resource/mcp`;

export function protectedResourceMetadata(origin: string) {
  return {
    resource: mcpResource(origin),
    resource_name: "aion.ly",
    authorization_servers: [origin],
    scopes_supported: [AGENT_SCOPE],
    bearer_methods_supported: ["header"],
    resource_documentation: `${origin}/agents`,
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/oauth/authorize`,
    token_endpoint: `${origin}/oauth/token`,
    registration_endpoint: `${origin}/oauth/register`,
    revocation_endpoint: `${origin}/oauth/revoke`,
    scopes_supported: [AGENT_SCOPE],
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none"],
    revocation_endpoint_auth_methods_supported: ["none"],
    client_id_metadata_document_supported: ADVERTISE_CLIENT_DOCUMENTS,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/agents`,
  };
}

/** Whether a `resource` a client names is this board's MCP server or API. */
export function isOwnResource(resource: string | null, origin: string): boolean {
  if (resource === null || resource === "") return true;
  const trimmed = resource.replace(/\/+$/, "");
  return trimmed === origin || trimmed === mcpResource(origin) || trimmed === `${origin}/api/v1`;
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

/**
 * Whether a redirect address a client registers is allowed: https, a
 * loopback http address for an app on the user's own machine, or an app's
 * own private scheme (RFC 8252). Never a fragment, credentials, or a
 * scheme a browser would run.
 */
export function redirectProblem(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "not an address";
  }
  if (raw.length > 500) return "too long";
  if (url.hash || url.username || url.password) return "has a fragment or credentials";
  if (url.protocol === "https:") return null;
  if (url.protocol === "http:") return LOOPBACK.has(url.hostname) ? null : "http is only for this machine";
  const scheme = url.protocol.slice(0, -1);
  if (["javascript", "data", "file", "blob", "vbscript", "about", "ftp", "ws", "wss"].includes(scheme)) return "not a usable scheme";
  // A private scheme is the app's reversed domain, such as com.example.app.
  return /^[a-z][a-z0-9+.-]*\.[a-z0-9+.-]+$/.test(scheme) || /^[a-z][a-z0-9+-]{2,}$/.test(scheme) ? null : "not a usable scheme";
}

/**
 * Whether an authorization request's redirect is one the client registered.
 * Exact, except that a loopback address may use any port, since apps on
 * the user's machine listen wherever the system lets them (RFC 8252 §7.3).
 */
export function redirectMatches(registered: readonly string[], asked: string): boolean {
  if (registered.includes(asked)) return true;
  let target: URL;
  try {
    target = new URL(asked);
  } catch {
    return false;
  }
  if (target.protocol !== "http:" || !LOOPBACK.has(target.hostname)) return false;
  return registered.some((entry) => {
    try {
      const candidate = new URL(entry);
      return (
        candidate.protocol === "http:" &&
        candidate.hostname === target.hostname &&
        candidate.pathname === target.pathname &&
        candidate.search === target.search
      );
    } catch {
      return false;
    }
  });
}

/** PKCE's S256 check: the verifier's SHA-256, base64url, is the challenge. */
export async function pkceMatches(verifier: string, challenge: string): Promise<boolean> {
  if (!/^[A-Za-z0-9._~-]{43,128}$/.test(verifier)) return false;
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  const encoded = btoa(String.fromCharCode(...digest)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  if (encoded.length !== challenge.length) return false;
  let difference = 0;
  for (let index = 0; index < encoded.length; index += 1) difference |= encoded.charCodeAt(index) ^ challenge.charCodeAt(index);
  return difference === 0;
}

/** The address an authorization answer goes back to, with its parameters. */
export function answerUrl(redirectUri: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(params)) {
    if (value !== null && value !== undefined) url.searchParams.set(key, value);
  }
  return url.href;
}
