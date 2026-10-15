/**
 * A Model Context Protocol server over Streamable HTTP, kept stateless: no
 * sessions and no event streams, every request answered with plain JSON.
 * That is all tools need, and it runs in a Worker with nothing kept between
 * requests. It speaks both eras: the modern one (2026-07-28 on), where each
 * request carries its version and headers mirror its method, and the
 * earlier one that opens with `initialize`. Pure apart from what it is
 * handed, so it is unit-tested.
 */

/** Versions that carry their version on every request, with no handshake. */
export const MODERN_VERSIONS = ["2026-07-28"] as const;

/** Versions that open with `initialize`; newest first, the default for others. */
export const LEGACY_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"] as const;

export const PROTOCOL_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS] as const;

const VERSION_KEY = "io.modelcontextprotocol/protocolVersion";

/** How long a client may keep the tool list: it changes only with a deploy. */
const TOOLS_TTL_MS = 3_600_000;

export interface ToolAnnotations {
  title?: string;
  readOnlyHint?: boolean;
  destructiveHint?: boolean;
  idempotentHint?: boolean;
  openWorldHint?: boolean;
}

export type JsonSchema = Record<string, unknown>;

export interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
}

export interface Tool<Context> {
  name: string;
  title: string;
  description: string;
  inputSchema: JsonSchema;
  annotations: ToolAnnotations;
  run: (args: Record<string, unknown>, context: Context) => Promise<ToolResult>;
}

export interface ServerOptions<Context> {
  name: string;
  title: string;
  version: string;
  /** What the client passes to the model about using this server. */
  instructions: string;
  tools: ReadonlyArray<Tool<Context>>;
  /** The caller, or null to answer 401 so the client can sign in. */
  authorize: (request: Request) => Promise<Context | null>;
  /** The 401's `WWW-Authenticate`, naming where to start OAuth. */
  challenge: string;
  /** Whether the caller is within its request limit; past it, 429. */
  admit?: (request: Request, context: Context) => Promise<boolean>;
}

interface Message {
  jsonrpc?: unknown;
  id?: unknown;
  method?: unknown;
  params?: unknown;
}

const HEADERS = { "Cache-Control": "no-store" };

/** The largest message read: tool arguments are text, never files. */
const MAX_BODY = 256 * 1024;

/** Messages one batch from an early client may hold. */
const MAX_BATCH = 10;

/** Each tool list as clients see it, made once. */
const listed = new WeakMap<object, unknown[]>();

function toolList<Context>(tools: ReadonlyArray<Tool<Context>>): unknown[] {
  let list = listed.get(tools);
  if (!list) {
    list = tools.map((tool) => ({
      name: tool.name,
      title: tool.title,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: { title: tool.title, ...tool.annotations },
    }));
    listed.set(tools, list);
  }
  return list;
}

/** The body as text, or null past the limit, which stops reading there. */
async function readText(request: Request, maxBytes: number): Promise<string | null> {
  if (Number(request.headers.get("Content-Length") ?? "0") > maxBytes) return null;
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let total = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      return null;
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

function rpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0", id: id ?? null, error: { code, message } };
}

const isRequest = (message: Message) => typeof message.method === "string" && message.id !== undefined && message.id !== null;

export function textResult(text: string, structured?: Record<string, unknown>): ToolResult {
  return structured ? { content: [{ type: "text", text }], structuredContent: structured } : { content: [{ type: "text", text }] };
}

export function errorResult(text: string): ToolResult {
  return { content: [{ type: "text", text }], isError: true };
}

interface Answer {
  status: number;
  body: unknown;
}

/** A result, marked complete as the modern era requires of every one. */
function result(id: unknown, value: Record<string, unknown>, modern: boolean) {
  return { jsonrpc: "2.0", id, result: modern ? { resultType: "complete", ...value } : value };
}

async function answer<Context>(message: Message, options: ServerOptions<Context>, context: Context, modern: boolean): Promise<Answer> {
  const reply = (body: unknown, status = 200): Answer => ({ status, body });
  const { id } = message;
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
  const tools = () => toolList(options.tools);
  switch (message.method) {
    case "server/discover":
      return reply(
        result(
          id,
          {
            supportedVersions: [...PROTOCOL_VERSIONS],
            capabilities: { tools: { listChanged: false } },
            _meta: { "io.modelcontextprotocol/serverInfo": { name: options.name, title: options.title, version: options.version } },
            instructions: options.instructions,
            ttlMs: TOOLS_TTL_MS,
            cacheScope: "public",
          },
          true,
        ),
      );
    case "initialize": {
      const asked = typeof params.protocolVersion === "string" ? params.protocolVersion : "";
      const protocolVersion = (LEGACY_VERSIONS as readonly string[]).includes(asked) ? asked : LEGACY_VERSIONS[0];
      return reply(
        result(
          id,
          {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: options.name, title: options.title, version: options.version },
            instructions: options.instructions,
          },
          false,
        ),
      );
    }
    case "ping":
      return reply(result(id, {}, modern));
    case "tools/list":
      return reply(result(id, modern ? { tools: tools(), ttlMs: TOOLS_TTL_MS, cacheScope: "public" } : { tools: tools() }, modern));
    case "tools/call": {
      const tool = options.tools.find((candidate) => candidate.name === params.name);
      if (!tool) return reply(rpcError(id, -32602, `Unknown tool: ${String(params.name)}`));
      const args = params.arguments && typeof params.arguments === "object" && !Array.isArray(params.arguments) ? params.arguments : {};
      let outcome: ToolResult;
      try {
        outcome = await tool.run(args as Record<string, unknown>, context);
      } catch (error) {
        console.error("mcp tool", tool.name, error);
        outcome = errorResult("Something went wrong on aion.ly. Try again in a minute.");
      }
      return reply(result(id, { ...outcome }, modern));
    }
    default:
      // The modern era tells an unknown method from a missing endpoint by status.
      return reply(rpcError(id, -32601, `Method not found: ${String(message.method)}`), modern ? 404 : 200);
  }
}

/** A mirrored header's value, decoded from the Base64 form it may take. */
function headerValue(raw: string | null): string | null {
  if (raw === null) return null;
  const encoded = /^=\?base64\?([A-Za-z0-9+/=]*)\?=$/.exec(raw)?.[1];
  if (encoded === undefined) return raw;
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)));
  } catch {
    return null;
  }
}

/**
 * Why a modern request's headers do not match its body, if they do not:
 * its version, method, and the tool it calls must all agree.
 */
function headerMismatch(request: Request, message: Message, version: string): string | null {
  const params = (message.params && typeof message.params === "object" ? message.params : {}) as Record<string, unknown>;
  const meta = (params._meta && typeof params._meta === "object" ? params._meta : {}) as Record<string, unknown>;
  if (meta[VERSION_KEY] !== version) return `MCP-Protocol-Version ${version} does not match the request's _meta.`;
  const method = request.headers.get("Mcp-Method");
  if (method !== message.method) return `Mcp-Method header value '${method ?? ""}' does not match body value '${String(message.method)}'.`;
  if (message.method === "tools/call" || message.method === "resources/read" || message.method === "prompts/get") {
    const name = headerValue(request.headers.get("Mcp-Name"));
    const expected = message.method === "resources/read" ? params.uri : params.name;
    if (name !== expected) return `Mcp-Name header value '${name ?? ""}' does not match body value '${String(expected)}'.`;
  }
  return null;
}

/**
 * Answers one HTTP request to the MCP endpoint. A POST carries a JSON-RPC
 * message, or, from early clients, a batch of them; notifications and
 * responses get 202. There is no stream to GET and no session to DELETE.
 *
 * Any Origin is accepted: the endpoint reads only a bearer token, never a
 * cookie, so a page elsewhere can do nothing with it that its own script
 * holding the token could not.
 */
export async function handleMcp<Context>(request: Request, options: ServerOptions<Context>): Promise<Response> {
  const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
    Response.json(body, { status, headers: { ...HEADERS, ...headers } });
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { ...HEADERS, Allow: "POST" } });
  }
  const version = request.headers.get("MCP-Protocol-Version");
  if (version !== null && !(PROTOCOL_VERSIONS as readonly string[]).includes(version)) {
    return json(
      { jsonrpc: "2.0", id: null, error: { code: -32022, message: "Unsupported protocol version", data: { supported: [...PROTOCOL_VERSIONS], requested: version } } },
      400,
    );
  }
  const modern = version !== null && (MODERN_VERSIONS as readonly string[]).includes(version);

  const context = await options.authorize(request);
  if (context === null) {
    return json(rpcError(null, -32001, "Sign in to aion.ly to use its tools."), 401, { "WWW-Authenticate": options.challenge });
  }
  if (options.admit && !(await options.admit(request, context))) {
    return json(rpcError(null, -32000, "That was a lot at once. Wait a minute, then try again."), 429, { "Retry-After": "60" });
  }

  const text = await readText(request, MAX_BODY);
  if (text === null) return json(rpcError(null, -32600, "Requests are at most 256 KB."), 413);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return json(rpcError(null, -32700, "Parse error"), 400);
  }

  // The modern era sends one message per request, headers mirroring it.
  if (modern) {
    const message = parsed as Message;
    if (!message || typeof message !== "object" || Array.isArray(message) || message.jsonrpc !== "2.0") {
      return json(rpcError(null, -32600, "Invalid Request"), 400);
    }
    if (!isRequest(message)) return new Response(null, { status: 202, headers: HEADERS });
    const mismatch = headerMismatch(request, message, version!);
    if (mismatch) return json(rpcError(message.id, -32020, `Header mismatch: ${mismatch}`), 400);
    const reply = await answer(message, options, context, true);
    return json(reply.body, reply.status);
  }

  const messages = (Array.isArray(parsed) ? parsed : [parsed]) as Message[];
  if (messages.length === 0 || messages.some((message) => !message || typeof message !== "object" || message.jsonrpc !== "2.0")) {
    return json(rpcError(null, -32600, "Invalid Request"), 400);
  }
  if (messages.length > MAX_BATCH) return json(rpcError(null, -32600, `A batch holds at most ${MAX_BATCH} messages.`), 400);
  const answers: unknown[] = [];
  for (const message of messages) {
    if (isRequest(message)) answers.push((await answer(message, options, context, false)).body);
  }
  if (answers.length === 0) return new Response(null, { status: 202, headers: HEADERS });
  return json(Array.isArray(parsed) ? answers : answers[0]);
}
