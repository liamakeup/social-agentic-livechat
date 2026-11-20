/** Remote MCP client: JSON and SSE transports, session reuse, errors, proxy mode and result parsing. */
import { afterEach, describe, expect, test } from 'bun:test';
import worker from '../src/index';
import { MCP_PROTOCOL_VERSION, McpError, RemoteMcpClient, parseToolJson } from '../src/services/mcp';
import { createCtx, createEnv } from './helpers';
import { installFakeMcp, jsonContent } from './mcp-server';

let restore: () => void = () => {};
afterEach(() => restore());

describe('RemoteMcpClient', () => {
  test.each([false, true])('handshake, tools/list and tools/call over %s (false = JSON, true = SSE)', async (sse) => {
    const server = installFakeMcp({ sse, tools: ['a', 'b'], onTool: (_name, args) => jsonContent({ echo: args }) });
    restore = server.restore;
    const client = new RemoteMcpClient({ url: server.url, token: 'tok-123' });

    expect(await client.initialize()).toEqual({ serverName: 'fake-mcp' });
    expect((await client.listTools()).map((t) => t.name)).toEqual(['a', 'b']);
    const result = await client.callTool('a', { x: 1 });

    expect(parseToolJson(result)).toEqual({ echo: { x: 1 } });
    expect(server.calls.map((c) => c.method)).toEqual(['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    const headers = server.calls[0]!.headers;
    expect(headers.get('Authorization')).toBe('Bearer tok-123');
    expect(headers.get('Accept')).toBe('application/json, text/event-stream');
    expect(headers.get('MCP-Protocol-Version')).toBe(MCP_PROTOCOL_VERSION);
  });

  test('reuses the session id returned by initialize on every later request', async () => {
    const server = installFakeMcp({ sessionId: 'sess-42' });
    restore = server.restore;
    const client = new RemoteMcpClient({ url: server.url });

    await client.callTool('echo');
    await client.callTool('echo');

    expect(server.calls[0]!.headers.get('Mcp-Session-Id')).toBeNull();
    for (const call of server.calls.slice(1)) expect(call.headers.get('Mcp-Session-Id')).toBe('sess-42');
    expect(server.calls.filter((c) => c.method === 'initialize')).toHaveLength(1);
    expect(server.calls[0]!.headers.get('Authorization')).toBeNull();
  });

  test('a tool result flagged isError throws McpError; so does a JSON-RPC error', async () => {
    const server = installFakeMcp({
      onTool: (name) => {
        if (name === 'bad') return { isError: true, content: [{ type: 'text', text: 'conversation not found' }] };
        throw Object.assign(new Error('Unknown tool'), { code: -32602 });
      },
    });
    restore = server.restore;
    const client = new RemoteMcpClient({ url: server.url });

    const toolErr = await client.callTool('bad').catch((e) => e);
    expect(toolErr).toBeInstanceOf(McpError);
    expect(toolErr.message).toContain('conversation not found');

    const rpcErr = await client.callTool('other').catch((e) => e);
    expect(rpcErr).toBeInstanceOf(McpError);
    expect(rpcErr.code).toBe(-32602);
  });

  test('HTTP errors become McpError without leaking the token', async () => {
    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('bad token tok-secret', { status: 401 })) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
    const err = await new RemoteMcpClient({ url: 'https://mcp.example.com/mcp', token: 'tok-secret' }).initialize().catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toBe('MCP HTTP 401');
  });

  test('proxy mode wraps the call as {name, arguments} of the proxy tool', async () => {
    const server = installFakeMcp({ onTool: () => jsonContent({ ok: true }) });
    restore = server.restore;
    const client = new RemoteMcpClient({ url: server.url, proxyTool: 'call_tool' });

    await client.callTool('messages_list_inbox_conversations', { limit: 5 });

    const call = server.calls.find((c) => c.method === 'tools/call');
    expect(call?.params).toEqual({
      name: 'call_tool',
      arguments: { name: 'messages_list_inbox_conversations', arguments: { limit: 5 } },
    });
  });
});

/** Install a raw fetch handler for the MCP URL; records each JSON-RPC message with its headers. */
function rawMcp(handler: (message: any, headers: Headers, n: number) => Response | Promise<Response>) {
  const calls: Array<{ message: any; headers: Headers }> = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const message = JSON.parse(String(init?.body));
    const headers = new Headers(init?.headers);
    calls.push({ message, headers });
    return handler(message, headers, calls.length);
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

const URL_ = 'https://mcp.example.com/mcp';
const rpc = (id: unknown, result: unknown, headers: Record<string, string> = {}) =>
  Response.json({ jsonrpc: '2.0', id, result }, { headers });
const initResult = (protocolVersion = '2025-06-18') => ({ protocolVersion, capabilities: {}, serverInfo: { name: 's' } });

describe('RemoteMcpClient robustness', () => {
  test('an SSE response is used as soon as the matching message arrives, even if the stream stays open', async () => {
    let cancelled = false;
    rawMcp((message) => {
      if (message.id === undefined) return new Response(null, { status: 202 });
      const result = message.method === 'initialize' ? initResult() : jsonContent({ ok: true });
      const encoder = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(encoder.encode(': keep-alive\n\n'));
          // Split one event over two chunks; the stream is never closed by the server.
          const event = `event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: message.id, result })}\n\n`;
          controller.enqueue(encoder.encode(event.slice(0, 20)));
          controller.enqueue(encoder.encode(event.slice(20)));
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const client = new RemoteMcpClient({ url: URL_, timeoutMs: 1_000 });
    const started = Date.now();
    expect(parseToolJson(await client.callTool('x'))).toEqual({ ok: true });
    expect(Date.now() - started).toBeLessThan(900);
    expect(cancelled).toBe(true);
  });

  test('a silent SSE stream still times out, as an uncertain failure', async () => {
    rawMcp((message) => {
      if (message.method === 'initialize') return rpc(message.id, initResult());
      if (message.id === undefined) return new Response(null, { status: 202 });
      return new Response(new ReadableStream({ start() {} }), { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const err = await new RemoteMcpClient({ url: URL_, timeoutMs: 50 }).callTool('x').catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toBe('MCP request timed out');
    expect(err.uncertain).toBe(true);
  });

  test('sends the protocol version the server chose in initialize on later requests', async () => {
    const calls = rawMcp((message) => {
      if (message.method === 'initialize') return rpc(message.id, initResult('2025-03-26'));
      if (message.id === undefined) return new Response(null, { status: 202 });
      return rpc(message.id, jsonContent({}));
    });
    await new RemoteMcpClient({ url: URL_ }).callTool('x');
    expect(calls[0]!.headers.get('MCP-Protocol-Version')).toBe(MCP_PROTOCOL_VERSION);
    expect(calls[0]!.message.params.protocolVersion).toBe(MCP_PROTOCOL_VERSION);
    for (const call of calls.slice(1)) expect(call.headers.get('MCP-Protocol-Version')).toBe('2025-03-26');
  });

  test('HTTP 404 on an expired session starts a new session and retries a non-send request once', async () => {
    let session = 'sess-1';
    let expired = false;
    const calls = rawMcp((message, headers) => {
      if (message.method === 'initialize') {
        session = expired ? 'sess-2' : 'sess-1';
        return rpc(message.id, initResult(), { 'Mcp-Session-Id': session });
      }
      if (headers.get('Mcp-Session-Id') !== session) return new Response('session not found', { status: 404 });
      if (message.id === undefined) return new Response(null, { status: 202 });
      return rpc(message.id, jsonContent({ tool: message.params.name }));
    });
    const client = new RemoteMcpClient({ url: URL_, sendTool: 'send' });
    await client.callTool('list');
    expired = true;
    session = 'gone'; // the server forgot sess-1

    expect(parseToolJson(await client.callTool('list'))).toEqual({ tool: 'list' });
    const methods = calls.map((c) => `${c.message.method}${c.headers.get('Mcp-Session-Id') ? '@' + c.headers.get('Mcp-Session-Id') : ''}`);
    expect(methods).toEqual([
      'initialize',
      'notifications/initialized@sess-1',
      'tools/call@sess-1',
      'tools/call@sess-1', // 404: session expired
      'initialize', // new session, no stale id
      'notifications/initialized@sess-2',
      'tools/call@sess-2', // retried once
    ]);
    // A later list works on the new session without another handshake.
    await client.callTool('list');
    expect(calls.filter((c) => c.message.method === 'initialize')).toHaveLength(2);
  });

  test('a send whose session expired is not replayed: it fails as uncertain, and the next call re-initializes', async () => {
    let session = 'sess-1';
    const calls = rawMcp((message, headers) => {
      if (message.method === 'initialize') return rpc(message.id, initResult(), { 'Mcp-Session-Id': session });
      if (headers.get('Mcp-Session-Id') !== session) return new Response(null, { status: 404 });
      if (message.id === undefined) return new Response(null, { status: 202 });
      return rpc(message.id, jsonContent({}));
    });
    const client = new RemoteMcpClient({ url: URL_, sendTool: 'send', proxyTool: 'call_tool' });
    await client.callTool('list');
    session = 'sess-2';

    const err = await client.callTool('send', { message: 'hi' }).catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.uncertain).toBe(true);
    expect(calls.filter((c) => c.message.method === 'tools/call' && c.message.params.arguments.name === 'send')).toHaveLength(1);

    await client.callTool('list');
    expect(calls.filter((c) => c.message.method === 'initialize')).toHaveLength(2);
  });

  test('HTTP errors carry the JSON-RPC error message with the token scrubbed; 4xx is definite, 5xx uncertain', async () => {
    let status = 400;
    rawMcp((message) =>
      Response.json(
        { jsonrpc: '2.0', id: message.id ?? null, error: { code: -32600, message: 'Bad header for tok-secret' } },
        { status },
      ),
    );
    const client = () => new RemoteMcpClient({ url: URL_, token: 'tok-secret' });
    const bad = await client().initialize().catch((e) => e);
    expect(bad.message).toBe('MCP HTTP 400: Bad header for ***');
    expect(bad.uncertain).toBe(false);

    status = 502;
    const down = await client().initialize().catch((e) => e);
    expect(down.message).toBe('MCP HTTP 502: Bad header for ***');
    expect(down.uncertain).toBe(true);
  });

  test('a JSON-RPC error answered with id null (parse error) is reported with its message', async () => {
    for (const sse of [false, true]) {
      rawMcp(() => {
        const body = { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } };
        return sse
          ? new Response(`data: ${JSON.stringify(body)}\n\n`, { headers: { 'Content-Type': 'text/event-stream' } })
          : Response.json(body);
      });
      const err = await new RemoteMcpClient({ url: URL_ }).initialize().catch((e) => e);
      expect(err.message).toBe('MCP initialize error: Parse error');
      expect(err.code).toBe(-32700);
      expect(err.uncertain).toBe(false);
    }
  });

  test('an id-null JSON-RPC error on an SSE stream that stays open is the definite rejection, at once', async () => {
    let cancelled = false;
    rawMcp((message) => {
      if (message.method === 'initialize') return rpc(message.id, initResult());
      if (message.id === undefined) return new Response(null, { status: 202 });
      const event = `data: ${JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32602, message: 'Invalid params' } })}\n\n`;
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(event)); // and never closed
        },
        cancel() {
          cancelled = true;
        },
      });
      return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    const started = Date.now();
    const err = await new RemoteMcpClient({ url: URL_, timeoutMs: 1_000 }).callTool('send').catch((e) => e);
    expect(err).toBeInstanceOf(McpError);
    expect(err.message).toBe('MCP tools/call error: Invalid params');
    expect(err.uncertain).toBe(false);
    expect(Date.now() - started).toBeLessThan(900);
    expect(cancelled).toBe(true);
  });

  test('send outcome classification: isError and JSON-RPC errors are definite, network errors uncertain, handshake failures not sent', async () => {
    const server = installFakeMcp({
      onTool: (name) => {
        if (name === 'rejected') return { isError: true, content: [{ type: 'text', text: 'no' }] };
        throw new Error('boom');
      },
    });
    restore = server.restore;
    const client = new RemoteMcpClient({ url: server.url });
    expect((await client.callTool('rejected').catch((e) => e)).uncertain).toBe(false);
    expect((await client.callTool('rpc').catch((e) => e)).uncertain).toBe(false);
    server.restore();

    const original = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError('network down');
    }) as unknown as typeof fetch;
    restore = () => {
      globalThis.fetch = original;
    };
    // Already initialized: the tools/call itself failed in flight.
    const inFlight = await client.callTool('x').catch((e) => e);
    expect(inFlight.message).toBe('MCP server unreachable');
    expect(inFlight.uncertain).toBe(true);
    // Never initialized: the handshake failed, so the tool call was never sent.
    const notSent = await new RemoteMcpClient({ url: server.url }).callTool('x').catch((e) => e);
    expect(notSent.uncertain).toBe(false);
  });
});

describe('parseToolJson', () => {
  test('parses Zernio nested {result: "<json>"} payloads', () => {
    const inner = { data: [{ id: 'c1', unreadCount: 2 }] };
    expect(parseToolJson(jsonContent({ result: JSON.stringify(inner) }))).toEqual(inner);
  });

  test('joins split text content and keeps a plain string result', () => {
    expect(parseToolJson({ content: [{ type: 'text', text: '{"a":' }, { type: 'text', text: '1}' }] })).toEqual({ a: 1 });
    expect(parseToolJson(jsonContent({ result: 'done' }))).toEqual({ result: 'done' });
  });

  test('falls back to structuredContent and rejects non-JSON text', () => {
    expect(parseToolJson({ content: [], structuredContent: { x: 1 } })).toEqual({ x: 1 });
    expect(() => parseToolJson({ content: [{ type: 'text', text: 'hello' }] })).toThrow(McpError);
  });
});

describe('POST /api/mcp/test-connection', () => {
  test('reports server name and tools, or an error without the token', async () => {
    const server = installFakeMcp({ tools: ['call_tool', 'search_tools'] });
    restore = server.restore;
    const { env } = createEnv({ MCP_URL: server.url, MCP_TOKEN: 'tok-xyz' });
    const post = async () => {
      const res = await worker.fetch(
        new Request('https://w.example.com/api/mcp/test-connection', {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` },
        }),
        env,
        createCtx().ctx,
      );
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };

    expect(await post()).toEqual({ status: 200, body: { ok: true, serverName: 'fake-mcp', tools: ['call_tool', 'search_tools'] } });

    env.MCP_URL = 'https://other.example.com/mcp';
    const failed = await post();
    expect(failed.status).toBe(200);
    expect(failed.body.ok).toBe(false);
    expect(JSON.stringify(failed.body)).not.toContain('tok-xyz');
  });
});
