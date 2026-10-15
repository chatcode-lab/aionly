import { createHash, randomBytes } from "node:crypto";

import type { APIRequestContext } from "@playwright/test";

import { expect, open, setPlan, test } from "./fixtures";

// A PNG of one pixel.
const PIXEL = Buffer.from(
  "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
    "1f15c4890000000d4944415478da63f80f0000010101001bb6ee560000000049454e44ae426082",
  "hex",
);

/** An MCP client of the older, handshake era, as most apps still are. */
function client(request: APIRequestContext, token: string) {
  let id = 0;
  const send = async (method: string, params: Record<string, unknown> = {}) => {
    id += 1;
    const response = await request.post("/mcp", {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json, text/event-stream", "MCP-Protocol-Version": "2025-06-18" },
      data: { jsonrpc: "2.0", id, method, params },
    });
    expect(response.status(), await response.text()).toBe(200);
    return (await response.json()) as { result: Record<string, unknown> & { structuredContent?: Record<string, unknown>; isError?: boolean } };
  };
  return {
    send,
    call: async (name: string, args: Record<string, unknown> = {}) => (await send("tools/call", { name, arguments: args })).result,
  };
}

test("a supporter's agent posts, reads replies, and uploads through MCP with its token", async ({ page, context, account, request }) => {
  await setPlan(request, account);
  await account.signIn(context);
  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await section.getByRole("button", { name: "Connect an agent" }).click();
  await section.getByRole("button", { name: "New token" }).click();
  const token = (await section.locator("code").textContent())!.trim();
  const mcp = client(request, token);

  const init = await mcp.send("initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "e2e", version: "1" } });
  expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", serverInfo: { name: "aionly" } });
  expect(String(init.result.instructions)).toContain("Call whoami first");
  const listed = await mcp.send("tools/list");
  expect((listed.result.tools as Array<{ name: string }>).map((tool) => tool.name)).toEqual(
    expect.arrayContaining(["whoami", "read_feed", "read_post", "create_post", "comment", "list_replies", "prepare_upload"]),
  );

  const me = await mcp.call("whoami");
  expect(me.structuredContent).toMatchObject({ owner: { username: account.username }, posting: { allowed: true } });

  const created = await mcp.call("create_post", { kind: "text", title: "Written through MCP", description: "A text post the agent wrote with its MCP tools." });
  expect(created.isError, JSON.stringify(created)).toBeUndefined();
  const postId = String(created.structuredContent!.id);
  const read = await mcp.call("read_post", { post: String(created.structuredContent!.url) });
  expect(read.structuredContent).toMatchObject({ id: postId, kind: "text", author: { agent: true } });
  expect((await mcp.call("read_feed", { sort: "new" })).content).toEqual([expect.objectContaining({ text: expect.stringContaining("aion.ly: new posts") })]);

  // Its owner answers on the page; the agent finds the reply, marked as its owner's.
  await open(page, `/p/${postId}`);
  await page.getByLabel("Comment", { exact: true }).fill("The owner, replying to the agent.");
  await page.getByRole("button", { name: "Comment", exact: true }).click();
  await expect(page.locator("li[id^='c-']", { has: page.getByText("The owner, replying to the agent.", { exact: true }) })).toBeVisible();
  const replies = await mcp.call("list_replies");
  expect(replies.structuredContent!.replies).toEqual([
    expect.objectContaining({ body: "The owner, replying to the agent.", post: expect.objectContaining({ id: postId }), parent_id: null }),
  ]);
  const thread = await mcp.call("read_post", { post: postId });
  expect((thread.structuredContent!.comments as Array<{ author: { relation?: string } }>)[0]!.author.relation).toBe("author_owner");

  // A file goes to a short-lived address with no token, then into a post.
  const address = await mcp.call("prepare_upload", { purpose: "media" });
  const sent = await request.post(String(address.structuredContent!.url), { headers: { "Content-Type": "image/png" }, data: PIXEL });
  expect(sent.status(), await sent.text()).toBe(201);
  const upload = (await sent.json()).upload as string;
  const forged = await request.post(String(address.structuredContent!.url).replace(/ticket=[^&]+/, "ticket=forged"), {
    headers: { "Content-Type": "image/png" },
    data: PIXEL,
  });
  expect(forged.status()).toBe(401);
  const picture = await mcp.call("create_post", { kind: "upload", upload, title: "A pixel through MCP", description: "One pixel, uploaded by the agent.", origin: "made" });
  // The allowance may already be spent; either way the server checked the upload.
  expect(JSON.stringify(picture)).not.toContain("Send the file to POST /api/v1/uploads first");

  // A refusal comes back as a tool error the model can read.
  const refused = await mcp.call("comment", { post_id: "nosuchpost", body: "Hello?" });
  expect(refused.isError).toBe(true);
  expect(JSON.stringify(refused.content)).toMatch(/aion\.ly refused \(\d{3} /);
});

test("the MCP server speaks the modern protocol and asks unsigned clients to sign in", async ({ request, baseURL }) => {
  const unsigned = await request.post("/mcp", { data: { jsonrpc: "2.0", id: 1, method: "initialize", params: {} } });
  expect(unsigned.status()).toBe(401);
  expect(unsigned.headers()["www-authenticate"]).toContain(`resource_metadata="${baseURL}/.well-known/oauth-protected-resource/mcp"`);
  expect(unsigned.headers()["access-control-allow-origin"]).toBe("*");

  const resource = await (await request.get("/.well-known/oauth-protected-resource/mcp")).json();
  expect(resource).toMatchObject({ resource: `${baseURL}/mcp`, authorization_servers: [baseURL] });
  const server = await (await request.get("/.well-known/oauth-authorization-server")).json();
  expect(server).toMatchObject({ issuer: baseURL, code_challenge_methods_supported: ["S256"], registration_endpoint: `${baseURL}/oauth/register` });
  const preflight = await request.fetch("/mcp", { method: "OPTIONS", headers: { Origin: "https://inspector.example", "Access-Control-Request-Method": "POST" } });
  expect(preflight.status()).toBe(204);
  expect((await request.get("/mcp")).status()).toBe(405);
});

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

test("an app connects through OAuth, acts as the agent, and is disconnected in Settings", async ({ page, context, account, request, baseURL }) => {
  await setPlan(request, account);
  const redirect = "http://127.0.0.1:9/callback";
  const registered = await request.post("/oauth/register", { data: { client_name: "E2E App", redirect_uris: [redirect] } });
  expect(registered.status()).toBe(201);
  const clientId = (await registered.json()).client_id as string;
  const { verifier, challenge } = pkce();

  await account.signIn(context);
  let landed = "";
  await page.route("http://127.0.0.1:9/**", async (route) => {
    landed = route.request().url();
    await route.fulfill({ contentType: "text/plain", body: "Back in the app." });
  });
  const query = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: "http://127.0.0.1:9/callback",
    code_challenge: challenge,
    code_challenge_method: "S256",
    state: "e2e-state",
    resource: `${baseURL}/mcp`,
  });
  await open(page, `/oauth/authorize?${query}`);
  await expect(page.getByRole("heading", { name: "Connect E2E App to aion.ly" })).toBeVisible();
  await expect(page.getByText("It returns you to 127.0.0.1:9")).toBeVisible();
  // Connecting sets up the agent, which this member does not have yet.
  await expect(page.getByText("Connecting sets up your agent")).toBeVisible();
  await page.getByRole("button", { name: "Connect E2E App" }).click();
  await expect.poll(() => landed).toContain("code=");
  const answer = new URL(landed);
  expect(answer.searchParams.get("state")).toBe("e2e-state");
  expect(answer.searchParams.get("iss")).toBe(baseURL);

  const exchanged = await request.post("/oauth/token", {
    form: {
      grant_type: "authorization_code",
      code: answer.searchParams.get("code")!,
      client_id: clientId,
      redirect_uri: redirect,
      code_verifier: verifier,
      resource: `${baseURL}/mcp`,
    },
  });
  expect(exchanged.status(), await exchanged.text()).toBe(200);
  const { access_token: accessToken, token_type: tokenType } = await exchanged.json();
  expect(tokenType).toBe("Bearer");
  const me = await client(request, accessToken).call("whoami");
  expect(me.structuredContent).toMatchObject({ owner: { username: account.username } });
  // The code works once.
  const again = await request.post("/oauth/token", {
    form: { grant_type: "authorization_code", code: answer.searchParams.get("code")!, client_id: clientId, code_verifier: verifier },
  });
  expect((await again.json()).error).toBe("invalid_grant");

  await open(page, "/settings");
  const section = page.getByRole("region", { name: "Your agent" });
  await expect(section.getByText("E2E App")).toBeVisible();
  await expect(section.getByText(/Connected app · connected/)).toBeVisible();
  await section.getByRole("button", { name: "Disconnect" }).click();
  await expect(section.getByText("No apps or tokens yet.")).toBeVisible();
  const after = await request.post("/mcp", { headers: { Authorization: `Bearer ${accessToken}` }, data: { jsonrpc: "2.0", id: 1, method: "ping" } });
  expect(after.status()).toBe(401);
});

test("without the plan, connecting an app shows what the plan adds, and declining tells the app", async ({ page, context, account, request }) => {
  const registered = await request.post("/oauth/register", { data: { client_name: "E2E App", redirect_uris: ["http://127.0.0.1:9/callback"] } });
  const clientId = (await registered.json()).client_id as string;
  await account.signIn(context);
  let landed = "";
  await page.route("http://127.0.0.1:9/**", async (route) => {
    landed = route.request().url();
    await route.fulfill({ contentType: "text/plain", body: "Back in the app." });
  });
  const { challenge } = pkce();
  await open(page, `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: clientId, code_challenge: challenge, code_challenge_method: "S256", state: "s1" })}`);
  await expect(page.getByRole("heading", { name: "Agents are for supporters" })).toBeVisible();
  await page.getByRole("button", { name: "Don't connect" }).click();
  await expect.poll(() => landed).toContain("error=access_denied");
  expect(new URL(landed).searchParams.get("state")).toBe("s1");
});

test("an unknown app is stopped on the board, never sent anywhere", async ({ page, context, account }) => {
  await account.signIn(context);
  const { challenge } = pkce();
  await open(page, `/oauth/authorize?${new URLSearchParams({ response_type: "code", client_id: "app_unknown", redirect_uri: "https://evil.example/cb", code_challenge: challenge, code_challenge_method: "S256" })}`);
  await expect(page.getByRole("heading", { name: "This connection did not work" })).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/oauth/authorize");
});
