/** /api/settings: secrets never returned, keep/clear semantics, encryption at rest and validation. */
import { describe, expect, test } from 'bun:test';
import worker from '../src/index';
import { buildRagMessages } from '../src/services/ai';
import { loadSettings } from '../src/services/settings';
import type { Env } from '../src/types';
import { createCtx, createEnv } from './helpers';

const REMOTE = 'https://docflare-ai.example.workers.dev';
const API_KEY = 'sk-live-very-secret-123';
const MCP_TOKEN = 'mcp-token-very-secret-456';

async function api(env: Env, method = 'GET', body?: unknown) {
  const res = await worker.fetch(
    new Request(`${REMOTE}/api/settings`, {
      method,
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    createCtx().ctx,
  );
  const text = await res.text();
  return { status: res.status, text, body: JSON.parse(text) as Record<string, any> };
}

describe('GET /api/settings', () => {
  test('returns defaults and env values in the documented shape', async () => {
    const { env } = createEnv({ FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1', FALLBACK_API_KEY: API_KEY, MCP_TOKEN });
    const { status, body, text } = await api(env);

    expect(status).toBe(200);
    expect(body).toEqual({
      prompt: { systemPrompt: '' },
      fallback: { strategy: 'cf-first', baseUrl: 'https://api.groq.com/openai/v1', model: '', apiKeySet: true, apiKeyUndecryptable: false },
      mcp: {
        url: '',
        tokenSet: true,
        tokenUndecryptable: false,
        proxyTool: '',
        socialSiteId: '',
        socialMode: 'off',
        pollIntervalMinutes: 2,
        maxRepliesPerTick: 3,
        accountId: '',
        toolListConversations: 'messages_list_inbox_conversations',
        toolListMessages: 'messages_get_inbox_conversation_messages',
        toolSendMessage: 'messages_send_inbox_message',
        socialEnabledAt: null,
      },
    });
    expect(text).not.toContain(API_KEY);
    expect(text).not.toContain(MCP_TOKEN);
  });

  test('requires the admin token', async () => {
    const { env } = createEnv();
    const res = await worker.fetch(new Request(`${REMOTE}/api/settings`), env, createCtx().ctx);
    expect(res.status).toBe(401);
  });
});

describe('POST /api/settings', () => {
  test('secrets are encrypted at rest, never returned, kept when omitted or "" and cleared by null', async () => {
    const { env, sqlite } = createEnv();

    const saved = await api(env, 'POST', {
      fallback: { baseUrl: 'https://llm.example.com/v1', model: 'm', apiKey: API_KEY },
      mcp: { token: MCP_TOKEN },
    });
    expect(saved.status).toBe(200);
    expect(saved.body.fallback.apiKeySet).toBe(true);
    expect(saved.body.mcp.tokenSet).toBe(true);
    expect(saved.text).not.toContain(API_KEY);
    expect(saved.text).not.toContain(MCP_TOKEN);

    const stored = sqlite.query(`SELECT value FROM app_settings WHERE key = 'fallback.apiKey'`).get() as { value: string };
    expect(stored.value).toStartWith('"v1:');
    expect(stored.value).not.toContain(API_KEY);
    expect((await loadSettings(env)).fallback.apiKey).toBe(API_KEY);

    // Omitted and "" keep the secret.
    await api(env, 'POST', { fallback: { model: 'm2' } });
    await api(env, 'POST', { fallback: { apiKey: '' }, mcp: { token: '' } });
    const kept = await loadSettings(env);
    expect(kept.fallback.apiKey).toBe(API_KEY);
    expect(kept.mcp.token).toBe(MCP_TOKEN);
    expect(kept.fallback.model).toBe('m2');

    // null clears, even when an env var would provide a value.
    env.FALLBACK_API_KEY = 'env-key';
    const cleared = await api(env, 'POST', { fallback: { apiKey: null } });
    expect(cleared.body.fallback.apiKeySet).toBe(false);
    expect((await loadSettings(env)).fallback.apiKey).toBe('');
    expect((await loadSettings(env)).mcp.token).toBe(MCP_TOKEN);
  });

  test('a secret that no longer decrypts (key rotated) is treated as unset', async () => {
    const { env } = createEnv();
    await api(env, 'POST', { mcp: { token: MCP_TOKEN } });
    env.SETTINGS_KEY = 'a-different-key-material';
    expect((await loadSettings(env)).mcp.token).toBe('');
    const view = (await api(env)).body;
    expect(view.mcp.tokenSet).toBe(false);
    expect(view.mcp.tokenUndecryptable).toBe(true);
    expect(view.fallback.apiKeyUndecryptable).toBe(false);

    // Saving the token again (with the current key) clears the flag.
    const saved = await api(env, 'POST', { mcp: { token: 'tok-new-0123456789' } });
    expect(saved.body.mcp).toMatchObject({ tokenSet: true, tokenUndecryptable: false });
    expect((await api(env)).body.mcp.tokenUndecryptable).toBe(false);
  });

  test('empty URLs are accepted and clear the value', async () => {
    const { env } = createEnv({ MCP_URL: 'https://mcp.example.com/mcp' });
    await api(env, 'POST', { fallback: { baseUrl: 'https://llm.example.com/v1' } });

    const res = await api(env, 'POST', { fallback: { baseUrl: '' }, mcp: { url: '' } });

    expect(res.status).toBe(200);
    expect(res.body.fallback.baseUrl).toBe('');
    expect(res.body.mcp.url).toBe('');
    expect((await loadSettings(env)).mcp.url).toBe('');
  });

  test('turning social replies on records socialEnabledAt once', async () => {
    const { env, sqlite } = createEnv();
    sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('shop', 'shop.example.com', 'https://shop.example.com/s.xml')`);

    const on = await api(env, 'POST', { mcp: { url: 'https://mcp.example.com/mcp', socialSiteId: 'shop', socialMode: 'draft' } });
    expect(on.status).toBe(200);
    const enabledAt = on.body.mcp.socialEnabledAt as string;
    expect(Date.parse(enabledAt)).toBeGreaterThan(Date.now() - 10_000);

    const auto = await api(env, 'POST', { mcp: { socialMode: 'auto' } });
    expect(auto.body.mcp.socialEnabledAt).toBe(enabledAt);
  });

  test.each([
    [{ fallback: { strategy: 'random' } }],
    [{ fallback: { baseUrl: 'http://llm.example.com/v1' } }],
    [{ fallback: { baseUrl: 'not a url' } }],
    [{ mcp: { url: 'ftp://mcp.example.com' } }],
    [{ mcp: { socialMode: 'always' } }],
    [{ mcp: { pollIntervalMinutes: 0 } }],
    [{ mcp: { pollIntervalMinutes: 61 } }],
    [{ mcp: { pollIntervalMinutes: 1.5 } }],
    [{ mcp: { maxRepliesPerTick: 11 } }],
    [{ mcp: { toolSendMessage: 'bad name!' } }],
    [{ mcp: { toolSendMessage: '' } }],
    [{ prompt: { systemPrompt: 'x'.repeat(4001) } }],
    [{ prompt: 'nope' }],
    [{ mcp: { url: 'https://mcp.example.com/mcp', socialSiteId: 'missing', socialMode: 'auto' } }],
    [{ mcp: { socialSiteId: 'shop', socialMode: 'auto' } }],
  ])('rejects %j', async (body) => {
    const { env, sqlite } = createEnv();
    sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('shop', 'shop.example.com', 'https://shop.example.com/s.xml')`);
    const res = await api(env, 'POST', body);
    expect(res.status).toBe(400);
    expect(res.body.code).toBe('invalid_settings');
    expect(sqlite.query('SELECT COUNT(*) AS n FROM app_settings').get()).toEqual({ n: 0 });
  });

  test('accepts boundary values, localhost http and a persona prompt used in the RAG prompt', async () => {
    const { env } = createEnv();
    const res = await api(env, 'POST', {
      prompt: { systemPrompt: 'Bạn là trợ lý của tiệm makeup Lia.' },
      fallback: { strategy: 'external-first', baseUrl: 'http://localhost:11434/v1' },
      mcp: { pollIntervalMinutes: 60, maxRepliesPerTick: 10, proxyTool: 'call_tool' },
    });
    expect(res.status).toBe(200);
    expect(res.body.mcp).toMatchObject({ pollIntervalMinutes: 60, maxRepliesPerTick: 10, proxyTool: 'call_tool' });
    expect(res.body.prompt.systemPrompt).toBe('Bạn là trợ lý của tiệm makeup Lia.');

    const persona = (await loadSettings(env)).prompt.systemPrompt;
    const system = buildRagMessages('q', [], [], 'shop.example.com', persona)[0]!.content;
    expect(system).toStartWith('Bạn là trợ lý của tiệm makeup Lia.\n\nRules:');
    expect(system).not.toContain('You are DocFlare');
    expect(buildRagMessages('q', [], [], 'shop.example.com')[0]!.content).toStartWith('You are DocFlare');
  });

  test('moving mcp.url to another host without a new token clears the stored token', async () => {
    const { env } = createEnv();
    await api(env, 'POST', { mcp: { url: 'https://mcp.zernio.com/mcp', token: MCP_TOKEN } });

    // Same host, other path: the token stays.
    const samePath = await api(env, 'POST', { mcp: { url: 'https://mcp.zernio.com/v2/mcp' } });
    expect(samePath.body.mcp.tokenSet).toBe(true);
    expect((await loadSettings(env)).mcp.token).toBe(MCP_TOKEN);

    // Other host, no token supplied: cleared, so it is never sent to the new host.
    const moved = await api(env, 'POST', { mcp: { url: 'https://evil.example.com/mcp' } });
    expect(moved.status).toBe(200);
    expect(moved.body.mcp).toMatchObject({ url: 'https://evil.example.com/mcp', tokenSet: false });
    expect((await loadSettings(env)).mcp.token).toBe('');

    // Other host together with a new token: the new token is stored.
    const withToken = await api(env, 'POST', { mcp: { url: 'https://mcp.other.com/mcp', token: 'tok-for-other-host' } });
    expect(withToken.body.mcp.tokenSet).toBe(true);
    expect((await loadSettings(env)).mcp.token).toBe('tok-for-other-host');
  });

  test('clearing mcp.url clears the token too, so host A → "" → host B never sends A\'s token to B', async () => {
    const { env } = createEnv();
    await api(env, 'POST', { mcp: { url: 'https://mcp.zernio.com/mcp', token: MCP_TOKEN } });

    const cleared = await api(env, 'POST', { mcp: { url: '' } });
    expect(cleared.status).toBe(200);
    expect(cleared.body.mcp).toMatchObject({ url: '', tokenSet: false });

    const moved = await api(env, 'POST', { mcp: { url: 'https://evil.example.com/mcp' } });
    expect(moved.body.mcp).toMatchObject({ url: 'https://evil.example.com/mcp', tokenSet: false });
    expect((await loadSettings(env)).mcp.token).toBe('');
  });

  test('saving other fields, or the same host again, keeps the token', async () => {
    const { env } = createEnv();
    await api(env, 'POST', { mcp: { url: 'https://mcp.zernio.com/mcp', token: MCP_TOKEN } });
    await api(env, 'POST', { mcp: { accountId: 'acc-1' } });
    await api(env, 'POST', { mcp: { url: 'https://MCP.zernio.com/mcp' } });
    expect((await loadSettings(env)).mcp.token).toBe(MCP_TOKEN);
  });
});

describe('GET /api/health', () => {
  test('is public, reads no settings from D1 and says nothing about the fallback', async () => {
    const { env } = createEnv({ FALLBACK_BASE_URL: 'https://api.groq.com/openai/v1', FALLBACK_API_KEY: API_KEY });
    let d1Reads = 0;
    const prepare = env.DB.prepare.bind(env.DB);
    env.DB.prepare = ((sql: string) => {
      d1Reads++;
      return prepare(sql);
    }) as typeof env.DB.prepare;
    const res = await worker.fetch(new Request(`${REMOTE}/api/health`), env, createCtx().ctx);
    const body = (await res.json()) as Record<string, unknown>;
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.fallback).toBeUndefined();
    expect(d1Reads).toBe(0);
  });
});
