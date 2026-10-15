import { beforeEach, describe, expect, it } from "vitest";

import { agentForToken, agentOf, createAgent, MAX_APP_TOKENS, revokePresentedToken } from "../../app/lib/db/agents.server";
import { exchangeCode, findClient, issueCode, readAuthorization, registerClient, sweepOAuth } from "../../app/lib/oauth/clients.server";
import { DAY, db, NOW, reset, user } from "./fixtures";

const ORIGIN = "https://board.test";
const VERIFIER = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
const CHALLENGE = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
const REDIRECT = "http://127.0.0.1/callback";

let agentId = "";

beforeEach(async () => {
  await reset();
  await user("owner", "quiet_otter", { plan: true });
  const made = await createAgent(db, { ownerId: "owner", ownerName: "quiet_otter", now: NOW });
  agentId = made.ok ? made.agent.id : "";
});

async function registered(name = "Test App"): Promise<string> {
  const result = await registerClient(db, { client_name: name, redirect_uris: [REDIRECT] }, NOW);
  if (!result.ok) throw new Error(result.description);
  return String(result.client.client_id);
}

const authorizeParams = (clientId: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:54321/callback",
    code_challenge: CHALLENGE,
    code_challenge_method: "S256",
    state: "xyz",
    resource: `${ORIGIN}/mcp`,
    ...extra,
  });

async function codeFor(clientId: string, canWrite = false): Promise<string> {
  const read = await readAuthorization(db, authorizeParams(clientId), { now: NOW, origin: ORIGIN });
  if (!read.ok) throw new Error("authorization refused");
  return issueCode(db, read.request, agentId, { canWrite, now: NOW });
}

const tokenForm = (clientId: string, code: string, extra: Record<string, string> = {}) =>
  new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:54321/callback",
    code_verifier: VERIFIER,
    ...extra,
  });

describe("registration", () => {
  it("registers a public client with its redirects, and refuses unsafe ones", async () => {
    const result = await registerClient(db, { client_name: "Claude\u0007", redirect_uris: ["https://claude.ai/api/mcp/auth_callback"], token_endpoint_auth_method: "client_secret_post" }, NOW);
    expect(result).toMatchObject({ ok: true, client: { client_name: "Claude", token_endpoint_auth_method: "none", grant_types: ["authorization_code"] } });
    expect(await registerClient(db, { redirect_uris: ["http://evil.example/cb"] }, NOW)).toMatchObject({ ok: false, error: "invalid_redirect_uri" });
    expect(await registerClient(db, { redirect_uris: [] }, NOW)).toMatchObject({ ok: false });
    expect(await registerClient(db, { redirect_uris: [REDIRECT], grant_types: ["client_credentials"] }, NOW)).toMatchObject({ ok: false });
  });
});

describe("client metadata documents", () => {
  const documentId = "https://app.example/oauth/client.json";
  const fetcher = (document: unknown, status = 200) => {
    let calls = 0;
    const fake = (async () => {
      calls += 1;
      return Response.json(document, { status });
    }) as unknown as typeof fetch;
    return { fake, calls: () => calls };
  };

  it("fetches a document that names itself, and keeps it for a day", async () => {
    const { fake, calls } = fetcher({ client_id: documentId, client_name: "Example", redirect_uris: [REDIRECT] });
    expect(await findClient(db, documentId, { now: NOW, ownHost: "board.test", fetcher: fake })).toMatchObject({ name: "Example", document: true });
    await findClient(db, documentId, { now: NOW + 3600, ownHost: "board.test", fetcher: fake });
    expect(calls()).toBe(1);
    await findClient(db, documentId, { now: NOW + 2 * DAY, ownHost: "board.test", fetcher: fake });
    expect(calls()).toBe(2);
  });

  it("refuses a document for another address, or one on the board itself", async () => {
    const { fake } = fetcher({ client_id: "https://other.example/client.json", redirect_uris: [REDIRECT] });
    expect(await findClient(db, documentId, { now: NOW, ownHost: "board.test", fetcher: fake })).toBeNull();
    const own = fetcher({ client_id: "https://board.test/client.json", redirect_uris: [REDIRECT] });
    expect(await findClient(db, "https://board.test/client.json", { now: NOW, ownHost: "board.test", fetcher: own.fake })).toBeNull();
    expect(own.calls()).toBe(0);
  });
});

describe("authorization", () => {
  it("shows an unknown app or a strange redirect on the board, and sends other problems back", async () => {
    expect(await readAuthorization(db, authorizeParams("app_unknown"), { now: NOW, origin: ORIGIN })).toMatchObject({ ok: false, show: expect.any(String) });
    const clientId = await registered();
    expect(
      await readAuthorization(db, authorizeParams(clientId, { redirect_uri: "https://evil.example/cb" }), { now: NOW, origin: ORIGIN }),
    ).toMatchObject({ ok: false, show: expect.any(String) });
    expect(
      await readAuthorization(db, authorizeParams(clientId, { code_challenge_method: "plain" }), { now: NOW, origin: ORIGIN }),
    ).toMatchObject({ ok: false, redirect: { error: "invalid_request", state: "xyz" } });
    expect(
      await readAuthorization(db, authorizeParams(clientId, { resource: "https://other.example/mcp" }), { now: NOW, origin: ORIGIN }),
    ).toMatchObject({ ok: false, redirect: { error: "invalid_target" } });
  });
});

describe("the token exchange", () => {
  it("trades a code once, with the right verifier, for an agent token named after the app", async () => {
    const clientId = await registered();
    const code = await codeFor(clientId);
    expect(await exchangeCode(db, tokenForm(clientId, code, { code_verifier: `${VERIFIER.slice(0, -1)}x` }), { now: NOW, origin: ORIGIN })).toMatchObject({
      ok: false,
      error: "invalid_grant",
    });
    // A failed try spends the code, so it cannot be guessed at.
    expect(await exchangeCode(db, tokenForm(clientId, code), { now: NOW, origin: ORIGIN })).toMatchObject({ ok: false, error: "invalid_grant" });

    const fresh = await codeFor(clientId);
    const result = await exchangeCode(db, tokenForm(clientId, fresh), { now: NOW, origin: ORIGIN });
    expect(result.ok).toBe(true);
    const token = result.ok ? result.token : "";
    // An app only reads unless the owner ticked the box when connecting it.
    expect(await agentForToken(db, token, NOW)).toMatchObject({ id: agentId, canWrite: false });
    expect((await agentOf(db, "owner"))?.tokens).toEqual([expect.objectContaining({ label: "Test App", app: true, canWrite: false })]);

    await revokePresentedToken(db, token, NOW);
    expect(await agentForToken(db, token, NOW)).toBeNull();

    const writing = await exchangeCode(db, tokenForm(clientId, await codeFor(clientId, true)), { now: NOW, origin: ORIGIN });
    expect(await agentForToken(db, writing.ok ? writing.token : "", NOW)).toMatchObject({ canWrite: true });
  });

  it("refuses another app's code, an expired one, and another redirect", async () => {
    const clientId = await registered();
    const other = await registered("Other");
    expect(await exchangeCode(db, tokenForm(other, await codeFor(clientId)), { now: NOW, origin: ORIGIN })).toMatchObject({ ok: false });
    expect(await exchangeCode(db, tokenForm(clientId, await codeFor(clientId)), { now: NOW + 3600, origin: ORIGIN })).toMatchObject({ ok: false });
    expect(
      await exchangeCode(db, tokenForm(clientId, await codeFor(clientId), { redirect_uri: "http://127.0.0.1:1/other" }), { now: NOW, origin: ORIGIN }),
    ).toMatchObject({ ok: false });
    expect(await exchangeCode(db, new URLSearchParams({ grant_type: "client_credentials" }), { now: NOW, origin: ORIGIN })).toMatchObject({
      error: "unsupported_grant_type",
    });
  });

  it("keeps the apps' tokens to a few, revoking the one used longest ago", async () => {
    const clientId = await registered();
    const tokens: string[] = [];
    for (let n = 0; n < MAX_APP_TOKENS + 1; n += 1) {
      const result = await exchangeCode(db, tokenForm(clientId, await codeFor(clientId)), { now: NOW + n, origin: ORIGIN });
      tokens.push(result.ok ? result.token : "");
    }
    expect((await agentOf(db, "owner"))?.tokens).toHaveLength(MAX_APP_TOKENS);
    expect(await agentForToken(db, tokens[0]!, NOW + 100)).toBeNull();
    expect(await agentForToken(db, tokens.at(-1)!, NOW + 100)).not.toBeNull();
  });
});

describe("the sweep", () => {
  it("forgets expired codes and apps that never connected", async () => {
    const connected = await registered("Connected");
    await exchangeCode(db, tokenForm(connected, await codeFor(connected)), { now: NOW, origin: ORIGIN });
    const abandoned = await registered("Abandoned");
    await codeFor(abandoned);
    await sweepOAuth(db, NOW + 2 * DAY);
    const left = await db.prepare(`SELECT name FROM oauth_clients ORDER BY name`).all<{ name: string }>();
    expect(left.results.map((row) => row.name)).toEqual(["Connected"]);
    expect((await db.prepare(`SELECT COUNT(*) AS n FROM oauth_codes`).first<{ n: number }>())!.n).toBe(0);
  });
});
