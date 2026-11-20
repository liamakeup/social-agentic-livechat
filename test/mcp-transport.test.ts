/**
 * MCP requests to the configured service host go through the MCP_SERVICE binding (same-account Workers
 * cannot reach each other over *.workers.dev); every other host uses the public fetch.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import { RemoteMcpClient } from '../src/services/mcp';
import { createMcpClient, mcpTransport } from '../src/services/social-agent';
import type { AppSettings } from '../src/services/settings';

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function initializeResponse(): Response {
  return new Response(
    JSON.stringify({ jsonrpc: '2.0', id: 1, result: { protocolVersion: '2025-06-18', serverInfo: { name: 'gw' }, capabilities: {} } }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function fakeBinding() {
  const urls: string[] = [];
  const binding = {
    async fetch(input: string, init?: RequestInit) {
      urls.push(input);
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      if (body.id === undefined) return new Response(null, { status: 202 });
      return initializeResponse();
    },
  };
  return { binding: binding as unknown as Fetcher, urls };
}

function settingsFor(url: string): AppSettings {
  return { mcp: { url, token: 't', proxyTool: '', toolSendMessage: 'send' } } as unknown as AppSettings;
}

describe('mcpTransport', () => {
  test('uses the binding only when the URL host matches MCP_SERVICE_HOST', () => {
    const { binding } = fakeBinding();
    const env = { MCP_SERVICE: binding, MCP_SERVICE_HOST: 'API.example.workers.dev' };
    expect(mcpTransport('https://api.example.workers.dev/mcp', env)).toBe(binding);
    expect(mcpTransport('https://other.example.com/mcp', env)).toBeUndefined();
    expect(mcpTransport('not a url', env)).toBeUndefined();
    expect(mcpTransport('https://api.example.workers.dev/mcp', { MCP_SERVICE: binding })).toBeUndefined();
    expect(mcpTransport('https://api.example.workers.dev/mcp', { MCP_SERVICE_HOST: 'api.example.workers.dev' })).toBeUndefined();
    expect(mcpTransport('https://api.example.workers.dev/mcp')).toBeUndefined();
  });

  test('client sends through the binding and never touches the global fetch', async () => {
    const { binding, urls } = fakeBinding();
    let globalCalls = 0;
    globalThis.fetch = (async () => {
      globalCalls++;
      return new Response('nope', { status: 404 });
    }) as unknown as typeof fetch;
    const client = createMcpClient(settingsFor('https://api.example.workers.dev/mcp'), {
      MCP_SERVICE: binding,
      MCP_SERVICE_HOST: 'api.example.workers.dev',
    });
    const { serverName } = await client.initialize();
    expect(serverName).toBe('gw');
    expect(urls.length).toBeGreaterThanOrEqual(1);
    expect(urls.every((u) => u === 'https://api.example.workers.dev/mcp')).toBe(true);
    expect(globalCalls).toBe(0);
  });

  test('without a matching binding the client uses the global fetch', async () => {
    let globalCalls = 0;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      globalCalls++;
      const body = JSON.parse(String(init?.body ?? '{}')) as { id?: number };
      return body.id === undefined ? new Response(null, { status: 202 }) : initializeResponse();
    }) as unknown as typeof fetch;
    const client = new RemoteMcpClient({ url: 'https://mcp.example.com/mcp' });
    await client.initialize();
    expect(globalCalls).toBeGreaterThanOrEqual(1);
  });
});
