/**
 * Minimal remote MCP client (Streamable HTTP transport, JSON-RPC 2.0), built on `fetch` only.
 *
 * Flow: `initialize` → `notifications/initialized` → `tools/list` / `tools/call`. Responses may be
 * plain JSON or an SSE stream; an SSE stream is read incrementally and abandoned as soon as the
 * `data:` message whose id matches the request arrives. The session id returned by the server
 * (`Mcp-Session-Id`) and the protocol version it chose are sent on every later request; an HTTP 404
 * to a request carrying the session id starts a new session (see `request`).
 */

export const MCP_PROTOCOL_VERSION = '2025-06-18';
const DEFAULT_TIMEOUT_MS = 15_000;
const CLIENT_INFO = { name: 'social-agentic-livechat', version: '0.1.0' };

/**
 * Any MCP failure: transport, HTTP status, JSON-RPC error or a tool result flagged `isError`.
 *
 * `uncertain` is true when the request may have reached the server and been executed without a
 * definite answer (timeout, network error, HTTP 5xx, unreadable or unmatched response, a session
 * that expired mid-call). It is false for a definite rejection (HTTP 4xx, JSON-RPC error, tool
 * `isError`) and for failures before the request was sent (e.g. the handshake).
 */
export class McpError extends Error {
  constructor(
    message: string,
    public readonly code?: number,
    public readonly uncertain = false,
    /** HTTP 404 on a request that carried a session id: the session expired. */
    public readonly sessionExpired = false,
  ) {
    super(message);
    this.name = 'McpError';
  }
}

export interface McpClientOptions {
  url: string;
  token?: string;
  /** When set, `callTool(name, args)` calls this tool with `{ name, arguments: args }` (e.g. Zernio "call_tool"). */
  proxyTool?: string;
  /**
   * Tool that sends a message to a customer. Such a call is never replayed after its session expired
   * (it may have been executed); every other request is retried once on a new session.
   */
  sendTool?: string;
  timeoutMs?: number;
  /** Transport for the HTTP requests (a service binding); defaults to the global `fetch`. */
  fetcher?: { fetch(input: string, init?: RequestInit): Promise<Response> };
}

export interface McpTool {
  name: string;
  description?: string;
}

export interface McpToolResult {
  content?: Array<{ type?: string; text?: string }>;
  structuredContent?: unknown;
  isError?: boolean;
}

type JsonRpcResponse = {
  jsonrpc?: string;
  id?: number | string | null;
  result?: unknown;
  error?: { code?: number; message?: string };
};

export class RemoteMcpClient {
  private sessionId: string | null = null;
  /** Protocol version the server chose in `initialize`; sent on every later request. */
  private protocolVersion: string | null = null;
  private nextId = 1;
  private initialized: Promise<{ serverName: string }> | null = null;

  constructor(private readonly options: McpClientOptions) {}

  /** Handshake once per client (and again after the session expired); later calls reuse the result. */
  initialize(): Promise<{ serverName: string }> {
    if (!this.initialized) {
      const attempt = (async () => {
        const result = (await this.request('initialize', {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: CLIENT_INFO,
        })) as { serverInfo?: { name?: string }; protocolVersion?: unknown } | undefined;
        if (typeof result?.protocolVersion === 'string' && result.protocolVersion.trim()) {
          this.protocolVersion = result.protocolVersion.trim();
        }
        await this.notify('notifications/initialized');
        return { serverName: String(result?.serverInfo?.name ?? '') };
      })();
      this.initialized = attempt;
      attempt.catch(() => {
        if (this.initialized === attempt) this.initialized = null;
      });
    }
    return this.initialized;
  }

  async listTools(): Promise<McpTool[]> {
    await this.initialize();
    const tools: McpTool[] = [];
    let cursor: string | undefined;
    // Follow pagination, bounded so a misbehaving server cannot loop forever.
    for (let page = 0; page < 5; page++) {
      const result = (await this.request('tools/list', cursor ? { cursor } : {})) as
        | { tools?: Array<{ name?: unknown; description?: unknown }>; nextCursor?: unknown }
        | undefined;
      for (const tool of result?.tools ?? []) {
        if (typeof tool?.name === 'string') {
          tools.push({ name: tool.name, description: typeof tool.description === 'string' ? tool.description : undefined });
        }
      }
      cursor = typeof result?.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (!cursor) break;
    }
    return tools;
  }

  /**
   * Call a tool (through the proxy tool when configured). Throws McpError when the result is an error.
   * A handshake failure is reported with `uncertain = false`: the tool call itself was never sent.
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    const started = Date.now();
    let ok = false;
    try {
      try {
        await this.initialize();
      } catch (err) {
        if (err instanceof McpError) throw new McpError(err.message, err.code, false);
        throw err;
      }
      const proxy = this.options.proxyTool;
      const params = proxy ? { name: proxy, arguments: { name, arguments: args } } : { name, arguments: args };
      const replayable = !this.options.sendTool || name !== this.options.sendTool;
      const result = ((await this.request('tools/call', params, replayable)) ?? {}) as McpToolResult;
      if (result.isError) throw new McpError(this.scrub(`Tool ${name} failed: ${toolText(result).slice(0, 300)}`));
      ok = true;
      return result;
    } finally {
      console.log(JSON.stringify({ event: 'mcp.tool', tool: name, ok, ms: Date.now() - started }));
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': this.protocolVersion ?? MCP_PROTOCOL_VERSION,
    };
    if (this.options.token) headers.Authorization = `Bearer ${this.options.token}`;
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;
    return headers;
  }

  private async notify(method: string): Promise<void> {
    await this.post({ jsonrpc: '2.0', method }, null);
  }

  /**
   * One JSON-RPC request. When the server answers HTTP 404 to a request carrying a session id, the
   * session is dropped and (for `replayable` requests) a new one is started and the request is sent
   * once more. A non-replayable request (a send) is not repeated: it fails as uncertain.
   */
  private async request(method: string, params: unknown, replayable = true): Promise<unknown> {
    try {
      return await this.requestOnce(method, params);
    } catch (err) {
      if (!(err instanceof McpError) || !err.sessionExpired) throw err;
      this.sessionId = null;
      if (method !== 'initialize') {
        this.initialized = null;
        this.protocolVersion = null;
      }
      if (!replayable) {
        throw new McpError(`MCP ${method}: session expired during the request`, 404, true);
      }
      if (method !== 'initialize') await this.initialize();
      return this.requestOnce(method, params);
    }
  }

  private async requestOnce(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    const response = await this.post({ jsonrpc: '2.0', id, method, params }, id);
    if (!response) throw new McpError(`MCP ${method}: empty response`, undefined, true);
    if (response.error) {
      throw new McpError(this.scrub(`MCP ${method} error: ${String(response.error.message ?? 'unknown error').slice(0, 300)}`), response.error.code);
    }
    return response.result;
  }

  /** POST one JSON-RPC message; returns the matching response (null for notifications). */
  private async post(message: Record<string, unknown>, id: number | null): Promise<JsonRpcResponse | null> {
    const controller = new AbortController();
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const hadSession = this.sessionId !== null;
    try {
      let res: Response;
      try {
        const transport = this.options.fetcher;
        const init: RequestInit = {
          method: 'POST',
          headers: this.headers(),
          body: JSON.stringify(message),
          signal: controller.signal,
        };
        res = await (transport ? transport.fetch(this.options.url, init) : fetch(this.options.url, init));
      } catch (err) {
        const aborted = err instanceof Error && err.name === 'AbortError';
        throw new McpError(aborted ? 'MCP request timed out' : 'MCP server unreachable', undefined, true);
      }
      const session = res.headers.get('Mcp-Session-Id');
      if (session) this.sessionId = session;
      if (!res.ok) throw await this.httpError(res, hadSession, controller.signal);
      if (id === null) {
        await res.body?.cancel().catch(() => {});
        return null;
      }
      const type = res.headers.get('Content-Type') ?? '';
      if (type.includes('text/event-stream')) return await readSseResponse(res, id, controller.signal);
      let text: string;
      try {
        text = await withAbort(res.text(), controller.signal);
      } catch {
        throw new McpError('MCP request timed out', undefined, true);
      }
      return parseJsonResponse(text, id);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * McpError for a non-2xx response, carrying the server's JSON-RPC error message when the body has one.
   * 4xx is a definite rejection; 5xx may have happened after the request was executed.
   */
  private async httpError(res: Response, hadSession: boolean, signal: AbortSignal): Promise<McpError> {
    let detail = '';
    try {
      const body = (await withAbort(res.text(), signal)).slice(0, 4096);
      const parsed = JSON.parse(body) as JsonRpcResponse | JsonRpcResponse[];
      const first = Array.isArray(parsed) ? parsed[0] : parsed;
      if (first && typeof first.error?.message === 'string') detail = first.error.message.slice(0, 300);
    } catch {
      // Not a JSON-RPC body (or unreadable): the status alone is reported.
      await res.body?.cancel().catch(() => {});
    }
    const message = this.scrub(`MCP HTTP ${res.status}${detail ? `: ${detail}` : ''}`);
    const expired = res.status === 404 && hadSession;
    return new McpError(message, res.status, res.status >= 500, expired);
  }

  /** Never let the token leak through an error message (e.g. a server echoing the request). */
  private scrub(message: string): string {
    const token = this.options.token;
    return token ? message.split(token).join('***') : message;
  }
}

/** Reject when `signal` aborts (the fetch timeout), so a body read can never outlive it. */
function withAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(new McpError('MCP request timed out', undefined, true));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new McpError('MCP request timed out', undefined, true));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (err) => {
        signal.removeEventListener('abort', onAbort);
        reject(err);
      },
    );
  });
}

/**
 * Read an SSE body incrementally and return the JSON-RPC message answering `id` as soon as it arrives;
 * the rest of the stream is cancelled, so a server that keeps the connection open cannot stall us.
 * Each POST carries exactly one request, so an error with id null on its stream can only be about that
 * request: it is returned at once too (a definite rejection, not a timeout).
 */
async function readSseResponse(res: Response, id: number, signal: AbortSignal): Promise<JsonRpcResponse> {
  if (!res.body) throw new McpError('MCP stream ended without a response', undefined, true);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await withAbort(reader.read(), signal);
      } catch (err) {
        if (err instanceof McpError) throw err;
        throw new McpError('MCP request timed out', undefined, true);
      }
      if (chunk.done) {
        buffer += decoder.decode();
        buffer += '\n\n';
      } else {
        buffer += decoder.decode(chunk.value, { stream: true });
      }
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
        const event = buffer.slice(0, boundary.index);
        buffer = buffer.slice(boundary.index + boundary[0].length);
        const message = sseMessage(event);
        if (!message) continue;
        if (matches(message, id) || isNullIdError(message)) return message;
      }
      if (chunk.done) break;
    }
  } finally {
    reader.cancel().catch(() => {});
  }
  throw new McpError('MCP stream ended without a response', undefined, true);
}

/** The JSON-RPC message carried by one SSE event (its `data:` lines), or null. */
function sseMessage(event: string): JsonRpcResponse | null {
  const data = event
    .split(/\r?\n/)
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n');
  if (!data) return null;
  try {
    const message = JSON.parse(data) as JsonRpcResponse;
    return message && typeof message === 'object' ? message : null;
  } catch {
    return null; // Not JSON (keep-alive or comment): ignore.
  }
}

/** A JSON-RPC error the server could not tie to a request (e.g. a parse error), answered with id null. */
function isNullIdError(message: JsonRpcResponse): boolean {
  return !!message && typeof message === 'object' && message.id === null && !!message.error;
}

function matches(message: JsonRpcResponse, id: number): boolean {
  return !!message && typeof message === 'object' && (message.id === id || message.id === String(id));
}

function parseJsonResponse(text: string, id: number): JsonRpcResponse {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new McpError('MCP server returned invalid JSON', undefined, true);
  }
  // Servers may answer with a JSON-RPC batch.
  const list = Array.isArray(parsed) ? (parsed as JsonRpcResponse[]) : [parsed as JsonRpcResponse];
  const found = list.find((m) => matches(m, id)) ?? list.find((m) => isNullIdError(m));
  if (!found) throw new McpError('MCP response did not match the request id', undefined, true);
  return found;
}

/** Concatenated text content of a tool result. */
export function toolText(result: McpToolResult): string {
  return (result.content ?? [])
    .filter((c) => typeof c?.text === 'string')
    .map((c) => c.text as string)
    .join('');
}

/**
 * Tool result as JSON: text content joined and parsed (falling back to structuredContent). Zernio
 * wraps payloads as `{ "result": "<json string>" }`; such an inner string is parsed too.
 */
export function parseToolJson(result: McpToolResult): unknown {
  const text = toolText(result).trim();
  let value: unknown;
  if (text) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new McpError('Tool returned non-JSON content');
    }
  } else if (result.structuredContent !== undefined) {
    value = result.structuredContent;
  } else {
    throw new McpError('Tool returned no content');
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const inner = (value as { result?: unknown }).result;
    if (typeof inner === 'string') {
      try {
        return JSON.parse(inner);
      } catch {
        // Plain string result: keep the outer object.
      }
    }
  }
  return value;
}
