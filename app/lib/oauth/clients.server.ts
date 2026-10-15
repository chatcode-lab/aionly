import { createAppToken, hashToken } from "../db/agents.server";
import { newId } from "../ids";
import { isOwnResource, pkceMatches, redirectMatches, redirectProblem } from "./metadata";

/** How long an authorization code works. */
export const CODE_SECONDS = 10 * 60;

/** How long a fetched client metadata document is trusted before it is fetched again. */
const DOCUMENT_SECONDS = 24 * 3600;

const DOCUMENT_MAX_BYTES = 10 * 1024;

const MAX_REDIRECTS = 5;

export interface OAuthClient {
  id: string;
  name: string;
  redirectUris: string[];
  /** Named by its metadata document's address, so the address vouches for it. */
  document: boolean;
}

export type OAuthError = { ok: false; error: string; description: string };

const refuse = (error: string, description: string): OAuthError => ({ ok: false, error, description });

/** A name an app gives itself, made safe to show: no controls, short. */
function cleanName(value: unknown, fallback: string): string {
  const name = typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, "").trim().slice(0, 60) : "";
  return name || fallback;
}

function redirectList(value: unknown): string[] | OAuthError {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_REDIRECTS || !value.every((uri) => typeof uri === "string")) {
    return refuse("invalid_redirect_uri", `Give 1 to ${MAX_REDIRECTS} redirect_uris.`);
  }
  for (const uri of value as string[]) {
    const problem = redirectProblem(uri);
    if (problem) return refuse("invalid_redirect_uri", `${uri}: ${problem}.`);
  }
  return value as string[];
}

/**
 * Registers an app that asks to be one (RFC 7591). Every app is a public
 * client: it holds no secret, and proves itself with PKCE instead.
 */
export async function registerClient(
  db: D1Database,
  input: unknown,
  now: number,
): Promise<{ ok: true; client: Record<string, unknown> } | OAuthError> {
  if (!input || typeof input !== "object" || Array.isArray(input)) return refuse("invalid_client_metadata", "Send a JSON object.");
  const metadata = input as Record<string, unknown>;
  const redirects = redirectList(metadata.redirect_uris);
  if (!Array.isArray(redirects)) return redirects;
  const grants = metadata.grant_types;
  if (Array.isArray(grants) && !grants.includes("authorization_code")) {
    return refuse("invalid_client_metadata", "Only the authorization_code grant is offered.");
  }
  const responses = metadata.response_types;
  if (Array.isArray(responses) && !responses.includes("code")) {
    return refuse("invalid_client_metadata", "Only the code response type is offered.");
  }
  const id = `app_${newId(24)}`;
  const name = cleanName(metadata.client_name, "An app");
  await db
    .prepare(`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?1, ?2, ?3, ?4)`)
    .bind(id, name, JSON.stringify(redirects), now)
    .run();
  return {
    ok: true,
    client: {
      client_id: id,
      client_id_issued_at: now,
      client_name: name,
      redirect_uris: redirects,
      grant_types: ["authorization_code"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    },
  };
}

/** Whether a client ID is the address of a metadata document. */
export function isDocumentId(clientId: string): boolean {
  return clientId.startsWith("https://");
}

/**
 * Fetches a client metadata document: an app's own address that describes
 * it, so it needs no registration. It must name itself, at that address.
 */
async function fetchDocument(clientId: string, ownHost: string, fetcher: typeof fetch): Promise<{ name: string; redirectUris: string[] } | null> {
  let url: URL;
  try {
    url = new URL(clientId);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.pathname === "/" || url.hash || url.username || url.password) return null;
  if (url.hostname === ownHost || clientId.length > 500) return null;
  let response: Response;
  try {
    response = await fetcher(url.href, {
      // Without a User-Agent, some apps' hosts refuse the request outright.
      headers: { Accept: "application/json", "User-Agent": "Mozilla/5.0 (compatible; aionly-oauth/1.0; +https://aion.ly/agents)" },
      redirect: "manual",
      signal: AbortSignal.timeout(5000),
    });
  } catch (error) {
    console.warn("client metadata document", clientId, String(error));
    return null;
  }
  if (response.status !== 200) {
    console.warn("client metadata document", clientId, response.status);
    await response.body?.cancel();
    return null;
  }
  const declared = Number(response.headers.get("Content-Length") ?? "0");
  if (declared > DOCUMENT_MAX_BYTES) {
    await response.body?.cancel();
    return null;
  }
  const text = await response.text();
  if (text.length > DOCUMENT_MAX_BYTES) return null;
  let document: Record<string, unknown>;
  try {
    document = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!document || typeof document !== "object" || document.client_id !== clientId) return null;
  const redirects = redirectList(document.redirect_uris);
  if (!Array.isArray(redirects)) return null;
  return { name: cleanName(document.client_name, url.hostname), redirectUris: redirects };
}

/**
 * The app behind a client ID: one that registered, or one whose metadata
 * document is fetched, or used from the last fetch while it is fresh. If a
 * fetch fails, the last good copy stands in.
 */
export async function findClient(
  db: D1Database,
  clientId: string,
  input: { now: number; ownHost: string; fetcher?: typeof fetch },
): Promise<OAuthClient | null> {
  if (!clientId || clientId.length > 500) return null;
  const row = await db
    .prepare(`SELECT id, name, redirect_uris, fetched_at FROM oauth_clients WHERE id = ?1`)
    .bind(clientId)
    .first<{ id: string; name: string; redirect_uris: string; fetched_at: number | null }>();
  const fromRow = (found: { id: string; name: string; redirect_uris: string }): OAuthClient => ({
    id: found.id,
    name: found.name,
    redirectUris: JSON.parse(found.redirect_uris) as string[],
    document: isDocumentId(found.id),
  });
  if (!isDocumentId(clientId)) return row ? fromRow(row) : null;
  if (row && row.fetched_at !== null && row.fetched_at > input.now - DOCUMENT_SECONDS) return fromRow(row);

  // The runtime's fetch must be called as itself, never detached.
  const fetched = await fetchDocument(clientId, input.ownHost, input.fetcher ?? ((url, init) => fetch(url, init)));
  if (!fetched) return row ? fromRow(row) : null;
  await db
    .prepare(
      `INSERT INTO oauth_clients (id, name, redirect_uris, fetched_at, created_at) VALUES (?1, ?2, ?3, ?4, ?4)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, redirect_uris = excluded.redirect_uris, fetched_at = excluded.fetched_at`,
    )
    .bind(clientId, fetched.name, JSON.stringify(fetched.redirectUris), input.now)
    .run();
  return { id: clientId, name: fetched.name, redirectUris: fetched.redirectUris, document: true };
}

/** The checked parts of an authorization request. */
export interface AuthorizationRequest {
  client: OAuthClient;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string | null;
}

/**
 * Reads an authorization request. A client or redirect that does not check
 * out is shown as an error on the board, never sent anywhere; once the
 * redirect is known good, other problems go back to it, as OAuth expects.
 */
export async function readAuthorization(
  db: D1Database,
  params: URLSearchParams,
  input: { now: number; origin: string; fetcher?: typeof fetch },
): Promise<
  | { ok: true; request: AuthorizationRequest }
  | { ok: false; show: string }
  | { ok: false; redirect: { uri: string; error: string; description: string; state: string | null } }
> {
  const clientId = params.get("client_id") ?? "";
  const client = await findClient(db, clientId, { now: input.now, ownHost: new URL(input.origin).hostname, fetcher: input.fetcher });
  if (!client) return { ok: false, show: "This app is not one aion.ly knows. Go back to it and try connecting again." };
  const redirectUri = params.get("redirect_uri") ?? (client.redirectUris.length === 1 ? client.redirectUris[0]! : "");
  if (!redirectMatches(client.redirectUris, redirectUri)) {
    return { ok: false, show: "This app asked to return somewhere it did not register. Nothing was shared." };
  }
  const state = params.get("state");
  const back = (error: string, description: string) => ({ ok: false as const, redirect: { uri: redirectUri, error, description, state } });
  if (params.get("response_type") !== "code") return back("unsupported_response_type", "Only response_type=code is offered.");
  const codeChallenge = params.get("code_challenge") ?? "";
  if (params.get("code_challenge_method") !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(codeChallenge)) {
    return back("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  const scope = params.get("scope");
  if (scope && !scope.split(" ").every((item) => item === "agent" || item === "")) return back("invalid_scope", "The only scope is agent.");
  const resource = params.get("resource");
  if (!isOwnResource(resource, input.origin)) return back("invalid_target", "This server issues tokens only for itself.");
  return { ok: true, request: { client, redirectUri, state, codeChallenge, resource } };
}

/** A one-time code for the app, kept as a hash, for the agent the owner chose. */
export async function issueCode(
  db: D1Database,
  request: AuthorizationRequest,
  agentId: string,
  input: { canWrite: boolean; now: number },
): Promise<string> {
  const code = newId(43);
  await db
    .prepare(
      `INSERT INTO oauth_codes (code_hash, client_id, agent_id, redirect_uri, code_challenge, resource, expires_at, can_write)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
    )
    .bind(
      await hashToken(code),
      request.client.id,
      agentId,
      request.redirectUri,
      request.codeChallenge,
      request.resource,
      input.now + CODE_SECONDS,
      input.canWrite ? 1 : 0,
    )
    .run();
  return code;
}

/**
 * Trades a code for an agent token (RFC 6749 §4.1.3, with PKCE). The code
 * is claimed and deleted in one statement, so it works once.
 */
export async function exchangeCode(
  db: D1Database,
  form: URLSearchParams,
  input: { now: number; origin: string },
): Promise<{ ok: true; token: string } | OAuthError> {
  if (form.get("grant_type") !== "authorization_code") return refuse("unsupported_grant_type", "Only authorization_code is offered.");
  const code = form.get("code") ?? "";
  if (!code || code.length > 100) return refuse("invalid_grant", "The code is missing.");
  const claimed = await db
    .prepare(
      `DELETE FROM oauth_codes WHERE code_hash = ?1
       RETURNING client_id, agent_id, redirect_uri, code_challenge, resource, expires_at, can_write`,
    )
    .bind(await hashToken(code))
    .first<{
      client_id: string;
      agent_id: string;
      redirect_uri: string;
      code_challenge: string;
      resource: string | null;
      expires_at: number;
      can_write: number;
    }>();
  if (!claimed || claimed.expires_at < input.now) return refuse("invalid_grant", "The code is not valid, or was used already.");
  if (form.get("client_id") !== claimed.client_id) return refuse("invalid_grant", "The code was issued to another app.");
  const redirect = form.get("redirect_uri");
  if (redirect !== null && redirect !== claimed.redirect_uri) return refuse("invalid_grant", "redirect_uri does not match.");
  if (!(await pkceMatches(form.get("code_verifier") ?? "", claimed.code_challenge))) {
    return refuse("invalid_grant", "code_verifier does not match the code_challenge.");
  }
  if (!isOwnResource(form.get("resource"), input.origin)) return refuse("invalid_target", "This server issues tokens only for itself.");

  const agent = await db
    .prepare(
      `SELECT agent.user_id, client.name FROM profiles AS agent
       JOIN profiles AS owner ON owner.user_id = agent.owner_id
       JOIN oauth_clients AS client ON client.id = ?2
       WHERE agent.user_id = ?1 AND agent.deleted_at IS NULL AND owner.deleted_at IS NULL`,
    )
    .bind(claimed.agent_id, claimed.client_id)
    .first<{ user_id: string; name: string }>();
  if (!agent) return refuse("invalid_grant", "The agent is no longer there.");
  const token = await createAppToken(db, {
    agentId: agent.user_id,
    clientId: claimed.client_id,
    label: agent.name,
    canWrite: claimed.can_write === 1,
    now: input.now,
  });
  if (!token) return refuse("invalid_grant", "The agent cannot be connected now: its owner's plan or standing has changed.");
  await db.prepare(`UPDATE oauth_clients SET last_used_at = ?2 WHERE id = ?1`).bind(claimed.client_id, input.now).run();
  return { ok: true, token };
}

/**
 * Forgets expired codes, and apps no token is held for: those that
 * registered but never connected within a day, those unused for three
 * months, and metadata documents not fetched for a month.
 */
export async function sweepOAuth(db: D1Database, now: number): Promise<void> {
  await db.batch([
    db.prepare(`DELETE FROM oauth_codes WHERE expires_at < ?1`).bind(now),
    db
      .prepare(
        `DELETE FROM oauth_clients
         WHERE id NOT IN (SELECT client_id FROM agent_tokens WHERE client_id IS NOT NULL AND revoked_at IS NULL)
           AND id NOT IN (SELECT client_id FROM oauth_codes)
           AND ((fetched_at IS NULL AND last_used_at IS NULL AND created_at < ?1 - 86400)
             OR (fetched_at IS NULL AND last_used_at < ?1 - 90 * 86400)
             OR (fetched_at IS NOT NULL AND fetched_at < ?1 - 30 * 86400))`,
      )
      .bind(now),
  ]);
}
