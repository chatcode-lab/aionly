import { describe, expect, it } from "vitest";

import { handleMcp, LEGACY_VERSIONS, type ServerOptions, textResult } from "./protocol";

const options: ServerOptions<{ who: string }> = {
  name: "test",
  title: "Test",
  version: "1.0.0",
  instructions: "Be kind.",
  challenge: 'Bearer resource_metadata="https://board.test/.well-known/oauth-protected-resource/mcp"',
  authorize: async (request) => (request.headers.get("Authorization") === "Bearer good" ? { who: "agent" } : null),
  tools: [
    {
      name: "echo",
      title: "Echo",
      description: "Says it back.",
      inputSchema: { type: "object", properties: { text: { type: "string" } } },
      annotations: { readOnlyHint: true },
      run: async (args, context) => textResult(`${context.who}: ${String(args.text)}`, { text: args.text }),
    },
    {
      name: "boom",
      title: "Boom",
      description: "Fails.",
      inputSchema: { type: "object" },
      annotations: {},
      run: async () => {
        throw new Error("kaboom");
      },
    },
  ],
};

function post(body: unknown, headers: Record<string, string> = {}) {
  return handleMcp(
    new Request("https://board.test/mcp", {
      method: "POST",
      headers: { Authorization: "Bearer good", "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
    options,
  );
}

const modern = (method: string, params: Record<string, unknown> = {}, headers: Record<string, string> = {}) =>
  post(
    { jsonrpc: "2.0", id: 7, method, params: { ...params, _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28" } } },
    { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": method, ...headers },
  );

describe("the handshake era", () => {
  it("answers initialize with the asked version, or its newest", async () => {
    const asked = await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } })).json();
    expect(asked).toMatchObject({
      id: 1,
      result: { protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "test" }, instructions: "Be kind." },
    });
    const unknown = await (await post({ jsonrpc: "2.0", id: 2, method: "initialize", params: { protocolVersion: "2099-01-01" } })).json();
    expect(unknown.result.protocolVersion).toBe(LEGACY_VERSIONS[0]);
  });

  it("acknowledges notifications with 202 and no body", async () => {
    const response = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(response.status).toBe(202);
    expect(await response.text()).toBe("");
  });

  it("lists and calls tools, with failures as tool errors the model can read", async () => {
    const list = await (await post({ jsonrpc: "2.0", id: 3, method: "tools/list" }, { "MCP-Protocol-Version": "2025-06-18" })).json();
    expect(list.result.tools.map((tool: { name: string }) => tool.name)).toEqual(["echo", "boom"]);
    expect(list.result.tools[0].annotations).toEqual({ title: "Echo", readOnlyHint: true });
    expect(list.result.resultType).toBeUndefined();

    const echoed = await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "echo", arguments: { text: "hi" } } })).json();
    expect(echoed.result).toEqual({ content: [{ type: "text", text: "agent: hi" }], structuredContent: { text: "hi" } });
    const failed = await (await post({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "boom" } })).json();
    expect(failed.result.isError).toBe(true);
    const missing = await (await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "nope" } })).json();
    expect(missing.error.code).toBe(-32602);
  });

  it("refuses a batch of more than 10 messages, and a caller past its limit", async () => {
    const many = Array.from({ length: 11 }, (_, index) => ({ jsonrpc: "2.0", id: index, method: "tools/list" }));
    const refused = await post(many);
    expect(refused.status).toBe(400);
    expect((await refused.json()).error.message).toBe("A batch holds at most 10 messages.");
    const ten = await (await post(many.slice(0, 10))).json();
    expect(ten).toHaveLength(10);
    expect(ten[0].result.tools).toEqual(ten[9].result.tools);
  });

  it("answers a batch from early clients, leaving out notifications", async () => {
    const answers = await (
      await post([
        { jsonrpc: "2.0", id: 1, method: "ping" },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 2, method: "nope" },
      ])
    ).json();
    expect(answers).toEqual([
      { jsonrpc: "2.0", id: 1, result: {} },
      { jsonrpc: "2.0", id: 2, error: { code: -32601, message: "Method not found: nope" } },
    ]);
  });
});

describe("the modern era", () => {
  it("discovers the server, marks every result complete, and lets clients cache the tools", async () => {
    const discovered = await (await modern("server/discover")).json();
    expect(discovered.result).toMatchObject({
      resultType: "complete",
      supportedVersions: expect.arrayContaining(["2026-07-28", "2025-06-18"]),
      capabilities: { tools: {} },
      _meta: { "io.modelcontextprotocol/serverInfo": { name: "test", version: "1.0.0" } },
      instructions: "Be kind.",
    });
    const list = await (await modern("tools/list")).json();
    expect(list.result).toMatchObject({ resultType: "complete", ttlMs: 3_600_000, cacheScope: "public" });
    const called = await (await modern("tools/call", { name: "echo", arguments: { text: "yo" } }, { "Mcp-Name": "echo" })).json();
    expect(called.result).toMatchObject({ resultType: "complete", content: [{ type: "text", text: "agent: yo" }] });
  });

  it("refuses headers that do not match the body", async () => {
    const wrongMethod = await modern("tools/list", {}, { "Mcp-Method": "tools/call" });
    expect(wrongMethod.status).toBe(400);
    expect((await wrongMethod.json()).error.code).toBe(-32020);
    const noName = await modern("tools/call", { name: "echo" });
    expect((await noName.json()).error.code).toBe(-32020);
    // A name may come Base64-encoded.
    const encoded = await modern("tools/call", { name: "echo", arguments: { text: "b64" } }, { "Mcp-Name": `=?base64?${btoa("echo")}?=` });
    expect(encoded.status).toBe(200);
    const otherVersion = await post(
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2025-11-25" } } },
      { "MCP-Protocol-Version": "2026-07-28", "Mcp-Method": "tools/list" },
    );
    expect((await otherVersion.json()).error.code).toBe(-32020);
  });

  it("tells an unknown method from a missing endpoint by status", async () => {
    const response = await modern("resources/list");
    expect(response.status).toBe(404);
    expect((await response.json()).error.code).toBe(-32601);
  });

  it("names its versions when asked for one it does not speak", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { "MCP-Protocol-Version": "2099-01-01" });
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.error).toMatchObject({ code: -32022, data: { requested: "2099-01-01", supported: expect.arrayContaining(["2026-07-28"]) } });
  });
});

describe("the endpoint", () => {
  it("asks for sign-in with the resource metadata's address", async () => {
    const response = await post({ jsonrpc: "2.0", id: 1, method: "initialize" }, { Authorization: "Bearer bad" });
    expect(response.status).toBe(401);
    expect(response.headers.get("WWW-Authenticate")).toContain("resource_metadata=");
  });

  it("has no stream to open and no session to end", async () => {
    for (const method of ["GET", "DELETE"]) {
      const response = await handleMcp(new Request("https://board.test/mcp", { method, headers: { Authorization: "Bearer good" } }), options);
      expect(response.status).toBe(405);
    }
  });

  it("refuses an oversized body and one that is not JSON-RPC", async () => {
    expect((await post("x".repeat(300 * 1024))).status).toBe(413);
    expect((await post("{not json")).status).toBe(400);
    expect((await post({ id: 1, method: "ping" })).status).toBe(400);
  });
});
