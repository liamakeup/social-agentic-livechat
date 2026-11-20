/**
 * In-process fake MCP server (Streamable HTTP) installed as the global fetch. Records every JSON-RPC
 * message with its headers and answers initialize / tools/list / tools/call as JSON or SSE.
 */
export interface RecordedRpc {
  method: string;
  id?: number;
  params?: any;
  headers: Headers;
}

export interface FakeMcpOptions {
  url?: string;
  sse?: boolean;
  sessionId?: string;
  tools?: string[];
  /** Tool implementation: returns the tool result object (content/isError) or throws for a JSON-RPC error. */
  onTool?: (name: string, args: any, params: any) => any;
}

export function installFakeMcp(options: FakeMcpOptions = {}) {
  const url = options.url ?? 'https://mcp.example.com/mcp';
  const calls: RecordedRpc[] = [];
  const original = globalThis.fetch;

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const target = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (target !== url) return new Response('not found', { status: 404 });
    const message = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    calls.push({ method: message.method, id: message.id, params: message.params, headers });
    if (message.id === undefined) return new Response(null, { status: 202 });

    let reply: Record<string, unknown>;
    try {
      let result: unknown;
      if (message.method === 'initialize') {
        result = { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-mcp', version: '1' } };
      } else if (message.method === 'tools/list') {
        result = { tools: (options.tools ?? ['echo']).map((name) => ({ name, inputSchema: { type: 'object' } })) };
      } else if (message.method === 'tools/call') {
        const { name, arguments: args } = message.params;
        result = options.onTool ? options.onTool(name, args, message.params) : { content: [{ type: 'text', text: '{}' }] };
      } else {
        throw Object.assign(new Error('Method not found'), { code: -32601 });
      }
      reply = { jsonrpc: '2.0', id: message.id, result };
    } catch (err: any) {
      reply = { jsonrpc: '2.0', id: message.id, error: { code: err.code ?? -32000, message: err.message } };
    }

    const responseHeaders: Record<string, string> = {};
    if (options.sessionId && message.method === 'initialize') responseHeaders['Mcp-Session-Id'] = options.sessionId;
    if (options.sse) {
      responseHeaders['Content-Type'] = 'text/event-stream';
      const notice = { jsonrpc: '2.0', method: 'notifications/message', params: { level: 'info' } };
      const body = `: keep-alive\n\nevent: message\ndata: ${JSON.stringify(notice)}\n\nevent: message\ndata: ${JSON.stringify(reply)}\n\n`;
      return new Response(body, { headers: responseHeaders });
    }
    responseHeaders['Content-Type'] = 'application/json';
    return new Response(JSON.stringify(reply), { headers: responseHeaders });
  }) as typeof fetch;

  return {
    url,
    calls,
    restore: () => {
      globalThis.fetch = original;
    },
  };
}

/** A tool result whose text is JSON. */
export const jsonContent = (value: unknown) => ({ content: [{ type: 'text', text: JSON.stringify(value) }] });
