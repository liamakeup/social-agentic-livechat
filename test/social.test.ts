/**
 * Social livechat agent against a fake Zernio-shaped MCP server: exactly-once replies, backlog
 * protection, per-conversation AI switch, human handoff, draft mode and the atomic admin send.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import worker from '../src/index';
import { loadConfig } from '../src/config';
import { Db } from '../src/db/schema';
import { pollSocialInbox } from '../src/services/social-agent';
import { loadSettings } from '../src/services/settings';
import type { Env } from '../src/types';
import { createCtx, createEnv } from './helpers';
import { installFakeMcp, jsonContent } from './mcp-server';

const REMOTE = 'https://agent.example.workers.dev';
let restore: () => void = () => {};
afterEach(() => restore());

async function api(env: Env, path: string, method = 'GET', body?: unknown) {
  const res = await worker.fetch(
    new Request(`${REMOTE}${path}`, {
      method,
      headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    env,
    createCtx().ctx,
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

interface InboxMessage {
  id: string;
  direction: 'incoming' | 'outgoing';
  text: string;
  createdAt: string;
}

/** A fake inbox with one conversation; `messages` newest first. Records every send. */
function setupInbox(messages: InboxMessage[], conversation: Record<string, unknown> = {}) {
  const sends: any[] = [];
  const server = installFakeMcp({
    onTool: (name, args) => {
      if (name === 'messages_list_inbox_conversations') {
        const data = [
          { id: 'conv-1', platform: 'facebook', accountId: 'acc-1', participantName: 'Lan', updatedTime: new Date(Date.now() + 60_000).toISOString(), unreadCount: 1, ...conversation },
        ];
        // Zernio wraps payloads as {result: "<json>"}.
        return jsonContent({ result: JSON.stringify({ data }) });
      }
      if (name === 'messages_get_inbox_conversation_messages') return jsonContent({ data: messages });
      if (name === 'messages_send_inbox_message') {
        sends.push(args);
        return jsonContent({ success: true });
      }
      throw new Error(`unexpected tool ${name}`);
    },
  });
  restore = server.restore;
  return { server, sends };
}

/** A registered site whose vector search always finds one pricing chunk. */
function setupEnv() {
  const ctx = createEnv({ RERANK: 'false' });
  ctx.sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('shop', 'shop.example.com', 'https://shop.example.com/s.xml')`);
  (ctx.vectorize.index as unknown as { query: () => Promise<unknown> }).query = async () => ({
    matches: [{ id: 'kb-a-0', score: 0.9, metadata: { siteId: 'shop', pageId: 'kb-a', url: 'kb:a', title: 'Giá', chunk: 0, text: 'Makeup cô dâu 2.000.000đ' } }],
    count: 1,
  });
  return ctx;
}

async function enable(env: Env, url: string, socialMode: 'auto' | 'draft') {
  const res = await api(env, '/api/settings', 'POST', { mcp: { url, socialSiteId: 'shop', socialMode } });
  expect(res.status).toBe(200);
  return res.body;
}

const future = (ms = 5_000) => new Date(Date.now() + ms).toISOString();
const poll = async (env: Env) => pollSocialInbox(env, loadConfig(env), await loadSettings(env));

describe('social agent', () => {
  test('auto mode sends exactly once even when polled twice and concurrently', async () => {
    const { env, sqlite } = setupEnv();
    const { server, sends } = setupInbox([
      { id: 'm2', direction: 'incoming', text: 'Giá makeup cô dâu bao nhiêu?', createdAt: future() },
      { id: 'm1', direction: 'outgoing', text: 'Chào bạn', createdAt: new Date().toISOString() },
    ]);
    await enable(env, server.url, 'auto');

    const [a, b] = await Promise.all([poll(env), poll(env)]);
    const c = await poll(env);

    expect(a.replied + b.replied + c.replied).toBe(1);
    expect(sends).toHaveLength(1);
    expect(sends[0]).toEqual({ conversation_id: 'conv-1', account_id: 'acc-1', message: 'test answer' });
    const rows = sqlite.query('SELECT status, reply_text, external_message_id FROM social_messages').all();
    expect(rows).toEqual([{ status: 'sent', reply_text: 'test answer', external_message_id: 'm2' }]);
  });

  test('messages written before social replies were enabled are never answered', async () => {
    const { env, sqlite } = setupEnv();
    const { server, sends } = setupInbox(
      [{ id: 'old', direction: 'incoming', text: 'Còn lịch không?', createdAt: new Date(Date.now() - 3_600_000).toISOString() }],
      { updatedTime: new Date().toISOString() },
    );
    await enable(env, server.url, 'auto');

    const summary = await poll(env);

    expect(summary.replied).toBe(0);
    expect(sends).toHaveLength(0);
    expect(sqlite.query('SELECT COUNT(*) AS n FROM social_messages').get()).toEqual({ n: 0 });
  });

  test('conversations with AI switched off and nothing new are skipped without any MCP call', async () => {
    const { env } = setupEnv();
    const { server, sends } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Giá?', createdAt: future() }], {
      updatedTime: future(60_000),
    });
    await enable(env, server.url, 'auto');
    // First poll in draft would create the row; create the conversation via a poll in draft mode then switch AI off.
    await api(env, '/api/settings', 'POST', { mcp: { socialMode: 'draft' } });
    await poll(env);
    const list = await api(env, '/api/social/conversations');
    const conv = list.body.conversations[0];
    expect((await api(env, `/api/social/conversations/${conv.id}/ai`, 'POST', { enabled: false })).body.aiEnabled).toBe(false);

    const tools = server.calls.length;
    await api(env, '/api/settings', 'POST', { mcp: { socialMode: 'auto' } });
    const summary = await poll(env);

    expect(summary.skipped).toBe(1);
    expect(sends).toHaveLength(0);
    // Only the list call was made for this tick (plus the handshake): no messages fetch, no send.
    expect(server.calls.slice(tools).filter((c) => c.method === 'tools/call')).toHaveLength(1);
  });

  test('a request for a human hands the conversation off and sends nothing', async () => {
    const { env, sqlite } = setupEnv();
    const { server, sends } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Cho mình gặp Nhân Viên tư vấn với', createdAt: future() }]);
    await enable(env, server.url, 'auto');

    const summary = await poll(env);

    expect(summary.handedOff).toBe(1);
    expect(sends).toHaveLength(0);
    expect(sqlite.query('SELECT status, reply_text FROM social_messages').get()).toEqual({ status: 'needs_human', reply_text: null });
    expect(sqlite.query('SELECT ai_enabled, status FROM social_conversations').get()).toEqual({ ai_enabled: 0, status: 'needs_human' });
    const list = await api(env, '/api/social/conversations?status=needs_human');
    expect(list.body.conversations).toHaveLength(1);
    expect(list.body.conversations[0].lastReplyStatus).toBe('needs_human');
  });

  test('no relevant knowledge also hands off', async () => {
    const { env, vectorize } = setupEnv();
    (vectorize.index as unknown as { query: () => Promise<unknown> }).query = async () => ({ matches: [], count: 0 });
    const { server, sends } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Shop có bán xe máy không?', createdAt: future() }]);
    await enable(env, server.url, 'auto');

    expect((await poll(env)).handedOff).toBe(1);
    expect(sends).toHaveLength(0);
  });

  test('draft mode stores the reply without sending; admin send is atomic and 409 afterwards', async () => {
    const { env } = setupEnv();
    const { server, sends } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Giá makeup?', createdAt: future() }]);
    await enable(env, server.url, 'draft');

    expect((await poll(env)).drafted).toBe(1);
    expect(sends).toHaveLength(0);

    const conv = (await api(env, '/api/social/conversations')).body.conversations[0];
    const messages = (await api(env, `/api/social/conversations/${conv.id}/messages`)).body.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ status: 'draft', replyText: 'test answer', customerText: 'Giá makeup?' });

    const path = `/api/social/messages/${messages[0].id}/send`;
    const [first, second] = await Promise.all([
      api(env, path, 'POST', { text: 'Dạ giá 2.000.000đ ạ' }),
      api(env, path, 'POST', { text: 'Dạ giá 2.000.000đ ạ' }),
    ]);
    const statuses = [first.status, second.status].sort();
    expect(statuses).toEqual([200, 409]);
    expect(sends).toHaveLength(1);
    expect(sends[0].message).toBe('Dạ giá 2.000.000đ ạ');

    const again = await api(env, path, 'POST', {});
    expect(again.status).toBe(409);
    expect(again.body.code).toBe('message_not_sendable');
    expect(sends).toHaveLength(1);
    const after = (await api(env, `/api/social/conversations/${conv.id}/messages`)).body.messages[0];
    expect(after).toMatchObject({ status: 'sent', replyText: 'Dạ giá 2.000.000đ ạ', error: null });
  });

  test('a failed send is recorded and never retried by the next poll', async () => {
    const { env, sqlite } = setupEnv();
    let attempts = 0;
    const server = installFakeMcp({
      onTool: (name) => {
        if (name === 'messages_list_inbox_conversations') {
          return jsonContent({ data: [{ id: 'conv-1', accountId: 'acc-1', updatedTime: future(60_000), unreadCount: 1 }] });
        }
        if (name === 'messages_get_inbox_conversation_messages') {
          return jsonContent({ data: [{ id: 'm1', direction: 'incoming', message: 'Giá?', timestamp: Math.floor(Date.now() / 1000) + 60 }] });
        }
        attempts++;
        return { isError: true, content: [{ type: 'text', text: 'window closed' }] };
      },
    });
    restore = server.restore;
    await enable(env, server.url, 'auto');

    const first = await poll(env);
    await poll(env);

    expect(first.errors).toHaveLength(1);
    expect(attempts).toBe(1);
    const row = sqlite.query('SELECT status, error FROM social_messages').get() as { status: string; error: string };
    expect(row.status).toBe('failed');
    expect(row.error).toContain('window closed');
  });

  test('POST /api/social/poll is refused while social replies are off', async () => {
    const { env } = setupEnv();
    const res = await api(env, '/api/social/poll', 'POST');
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('social_off');
  });

  test('a send that fails in flight is recorded as unknown, not failed, and needs confirmUnknown to resend', async () => {
    const { env, sqlite } = setupEnv();
    const { server, sends } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Giá?', createdAt: future() }]);
    await enable(env, server.url, 'auto');
    // The send request leaves but no answer comes back (network error after sending).
    const fakeFetch = globalThis.fetch;
    let dropSend = true;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const res = await fakeFetch(input, init);
      if (dropSend && String(init?.body).includes('messages_send_inbox_message')) throw new TypeError('connection reset');
      return res;
    }) as typeof fetch;

    const summary = await poll(env);
    expect(summary.replied).toBe(0);
    expect(summary.errors[0]).toContain('send outcome unknown');
    expect(sends).toHaveLength(1); // it did reach the platform
    const row = sqlite.query('SELECT id, status, error FROM social_messages').get() as { id: string; status: string; error: string };
    expect(row.status).toBe('unknown');
    expect(row.error).toBe('send outcome unknown; check the platform before resending (MCP server unreachable)');

    // Not retried by later polls.
    await poll(env);
    expect(sends).toHaveLength(1);

    const path = `/api/social/messages/${row.id}/send`;
    const refused = await api(env, path, 'POST', {});
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('confirm_required');
    expect(sends).toHaveLength(1);
    expect((await api(env, path, 'POST', { confirmUnknown: 'yes' })).status).toBe(400);

    dropSend = false;
    const resent = await api(env, path, 'POST', { confirmUnknown: true });
    expect(resent.status).toBe(200);
    expect(resent.body).toMatchObject({ status: 'sent', error: null });
    expect(sends).toHaveLength(2);
  });

  test('a definite rejection (HTTP 4xx) is failed and resendable without confirmation', async () => {
    const { env, sqlite } = setupEnv();
    const { server } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Giá?', createdAt: future() }]);
    await enable(env, server.url, 'auto');
    const fakeFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(init?.body).includes('messages_send_inbox_message')) return new Response('forbidden', { status: 403 });
      return fakeFetch(input, init);
    }) as typeof fetch;

    await poll(env);
    expect(sqlite.query('SELECT status, error FROM social_messages').get()).toEqual({ status: 'failed', error: 'MCP HTTP 403' });
  });

  test('when recording "sent" fails after a successful send, the row stays sending and is later recovered as unknown', async () => {
    const { env, sqlite } = setupEnv();
    const { server, sends } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Giá?', createdAt: future() }]);
    await enable(env, server.url, 'auto');
    sqlite.exec(`CREATE TRIGGER fail_sent BEFORE UPDATE ON social_messages WHEN NEW.status = 'sent'
      BEGIN SELECT RAISE(ABORT, 'D1 unavailable'); END`);

    const summary = await poll(env);
    expect(sends).toHaveLength(1);
    expect(summary.replied).toBe(1); // it was delivered
    expect(sqlite.query('SELECT status FROM social_messages').get()).toEqual({ status: 'sending' });

    // Not stale yet: untouched. Five minutes later: unknown, never failed.
    await poll(env);
    expect(sqlite.query('SELECT status FROM social_messages').get()).toEqual({ status: 'sending' });
    sqlite.exec(`UPDATE social_messages SET updated_at = datetime('now', '-6 minutes')`);
    const later = await poll(env);
    expect(later.recovered).toBe(1);
    expect(sqlite.query('SELECT status, error FROM social_messages').get()).toEqual({
      status: 'unknown',
      error: 'send outcome unknown; check the platform before resending',
    });
    expect(sends).toHaveLength(1);
  });

  test('stale claimed rows become failed ("interrupted before send") and stale sending rows unknown', async () => {
    const { env, sqlite } = setupEnv();
    const { server } = setupInbox([], { unreadCount: 0 });
    await enable(env, server.url, 'auto');
    sqlite.exec(`INSERT INTO social_conversations (id, account_id, conversation_id) VALUES ('c', 'acc-1', 'conv-9')`);
    const insert = (id: string, status: string, age: string) =>
      sqlite.exec(`INSERT INTO social_messages (id, conversation_row_id, external_message_id, status, reply_text, updated_at)
        VALUES ('${id}', 'c', '${id}', '${status}', 'r', datetime('now', '${age}'))`);
    insert('a', 'claimed', '-6 minutes');
    insert('b', 'sending', '-6 minutes');
    insert('c', 'claimed', '-1 minutes');
    insert('d', 'sending', '-1 minutes');

    expect((await poll(env)).recovered).toBe(2);
    const rows = sqlite.query('SELECT id, status, error FROM social_messages ORDER BY id').all();
    expect(rows).toEqual([
      { id: 'a', status: 'failed', error: 'interrupted before send' },
      { id: 'b', status: 'unknown', error: 'send outcome unknown; check the platform before resending' },
      { id: 'c', status: 'claimed', error: null },
      { id: 'd', status: 'sending', error: null },
    ]);
  });

  test('POST /api/social/poll runs under waitUntil and still returns the summary', async () => {
    const { env } = setupEnv();
    const { server } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'Giá?', createdAt: future() }]);
    await enable(env, server.url, 'draft');
    const { ctx, pending } = createCtx();
    const res = await worker.fetch(
      new Request(`${REMOTE}/api/social/poll`, { method: 'POST', headers: { Authorization: `Bearer ${env.ADMIN_TOKEN}` } }),
      env,
      ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as Record<string, number>).drafted).toBe(1);
    expect(pending).toHaveLength(1);
  });

  test('a newer draft supersedes older drafts of the conversation, which can no longer be sent', async () => {
    const { env, sqlite } = setupEnv();
    const messages: InboxMessage[] = [{ id: 'm1', direction: 'incoming', text: 'Giá makeup?', createdAt: future() }];
    const conversation = { updatedTime: future(60_000) };
    const { server, sends } = setupInbox(messages, conversation);
    await enable(env, server.url, 'draft');
    await poll(env);
    messages.unshift({ id: 'm2', direction: 'incoming', text: 'Còn lịch thứ 7 không?', createdAt: future(10_000) });
    conversation.updatedTime = future(70_000); // the platform moves updatedTime on a new message
    await poll(env);

    const rows = sqlite.query('SELECT id, external_message_id AS ext, status FROM social_messages ORDER BY rowid').all() as Array<{
      id: string;
      ext: string;
      status: string;
    }>;
    expect(rows.map((r) => [r.ext, r.status])).toEqual([
      ['m1', 'superseded'],
      ['m2', 'draft'],
    ]);
    const stale = await api(env, `/api/social/messages/${rows[0]!.id}/send`, 'POST', { text: 'Dạ 2 triệu ạ' });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('message_not_sendable');
    expect(sends).toHaveLength(0);
  });

  test('a handoff that cannot switch the conversation off leaves nothing half done', async () => {
    const { env, sqlite } = setupEnv();
    const { server } = setupInbox([{ id: 'm1', direction: 'incoming', text: 'cho gặp nhân viên', createdAt: future() }]);
    await enable(env, server.url, 'auto');
    sqlite.exec(`CREATE TRIGGER fail_handoff BEFORE UPDATE OF ai_enabled ON social_conversations
      BEGIN SELECT RAISE(ABORT, 'D1 unavailable'); END`);

    const summary = await poll(env);
    expect(summary.errors).toHaveLength(1);
    // Both statements rolled back together: still claimed (recovered later), AI still on.
    expect(sqlite.query('SELECT status FROM social_messages').get()).toEqual({ status: 'claimed' });
    expect(sqlite.query('SELECT ai_enabled, status FROM social_conversations').get()).toEqual({ ai_enabled: 1, status: 'open' });
  });
});

/** An inbox with several conversations; each has its own messages (newest first). Records sends. */
function setupMultiInbox(conversations: Array<{ id: string; updatedTime: string; messages: InboxMessage[] }>) {
  const sends: any[] = [];
  const fetched: string[] = [];
  const server = installFakeMcp({
    onTool: (name, args) => {
      if (name === 'messages_list_inbox_conversations') {
        return jsonContent({ data: conversations.map((c) => ({ id: c.id, accountId: 'acc-1', updatedTime: c.updatedTime, unreadCount: 1 })) });
      }
      if (name === 'messages_get_inbox_conversation_messages') {
        fetched.push(args.conversation_id);
        return jsonContent({ data: conversations.find((c) => c.id === args.conversation_id)?.messages ?? [] });
      }
      if (name === 'messages_send_inbox_message') {
        sends.push(args);
        return jsonContent({ success: true });
      }
      throw new Error(`unexpected tool ${name}`);
    },
  });
  restore = server.restore;
  return { server, sends, fetched };
}

const incoming = (id: string, text = 'Giá makeup?'): InboxMessage[] => [{ id, direction: 'incoming', text, createdAt: future() }];

describe('social agent tick scheduling', () => {
  test('unchanged and AI-off conversations do not take reply slots from a new customer', async () => {
    const { env, sqlite } = setupEnv();
    const t = future(60_000);
    const { server, sends, fetched } = setupMultiInbox([
      { id: 'old-1', updatedTime: t, messages: incoming('o1') },
      { id: 'old-2', updatedTime: t, messages: incoming('o2') },
      { id: 'off-1', updatedTime: t, messages: incoming('f1') },
      { id: 'new-1', updatedTime: t, messages: incoming('n1') },
    ]);
    await enable(env, server.url, 'auto');
    await api(env, '/api/settings', 'POST', { mcp: { maxRepliesPerTick: 1 } });
    // Already processed at this updatedTime, and one handed off whose state is also unchanged.
    sqlite.exec(`INSERT INTO social_conversations (id, account_id, conversation_id, last_message_at, ai_enabled) VALUES
      ('r1', 'acc-1', 'old-1', '${t}', 1), ('r2', 'acc-1', 'old-2', '${t}', 1), ('r3', 'acc-1', 'off-1', '${t}', 0)`);

    const summary = await poll(env);

    expect(summary).toMatchObject({ checked: 4, skipped: 3, replied: 1, replyCap: 1 });
    expect(fetched).toEqual(['new-1']); // the skipped ones cost no MCP call
    expect(sends.map((s) => s.conversation_id)).toEqual(['new-1']);
  });

  test('a new message in an AI-off conversation is recorded as needs_human without a reply slot or generation', async () => {
    const { env, sqlite, ai } = setupEnv();
    let generations = 0;
    ai.state.handler = (_model, inputs) => {
      if (Array.isArray(inputs.text)) return { data: inputs.text.map(() => new Array(1024).fill(0.01)) };
      generations++;
      return { response: 'test answer' };
    };
    const { server, sends } = setupMultiInbox([
      { id: 'off-1', updatedTime: future(60_000), messages: incoming('f2', 'Mình muốn đổi lịch') },
      { id: 'new-1', updatedTime: future(60_000), messages: incoming('n1') },
    ]);
    await enable(env, server.url, 'auto');
    await api(env, '/api/settings', 'POST', { mcp: { maxRepliesPerTick: 1 } });
    sqlite.exec(`INSERT INTO social_conversations (id, account_id, conversation_id, last_message_at, ai_enabled, status)
      VALUES ('r3', 'acc-1', 'off-1', 'earlier', 0, 'needs_human')`);

    const summary = await poll(env);

    expect(summary).toMatchObject({ needsHuman: 1, replied: 1 });
    expect(generations).toBe(1); // only for new-1
    expect(sends.map((s) => s.conversation_id)).toEqual(['new-1']);
    expect(sqlite.query(`SELECT status, customer_text, reply_text FROM social_messages WHERE conversation_row_id = 'r3'`).get()).toEqual({
      status: 'needs_human',
      customer_text: 'Mình muốn đổi lịch',
      reply_text: null,
    });
    const list = (await api(env, '/api/social/conversations?status=needs_human')).body.conversations;
    expect(list[0]).toMatchObject({ lastCustomerText: 'Mình muốn đổi lịch', lastReplyStatus: 'needs_human' });

    // Recorded once only.
    await poll(env);
    expect(sqlite.query(`SELECT COUNT(*) AS n FROM social_messages WHERE conversation_row_id = 'r3'`).get()).toEqual({ n: 1 });
  });

  test('replies are capped by the subrequest budget whatever maxRepliesPerTick says', async () => {
    const { env } = setupEnv();
    const conversations = Array.from({ length: 6 }, (_, i) => ({ id: `c${i}`, updatedTime: future(60_000), messages: incoming(`m${i}`) }));
    const { server, sends } = setupMultiInbox(conversations);
    await enable(env, server.url, 'auto');
    await api(env, '/api/settings', 'POST', { mcp: { maxRepliesPerTick: 10 } });

    const first = await poll(env);
    expect(first).toMatchObject({ replyCap: 4, replied: 4, checked: 4 });
    expect(sends).toHaveLength(4);

    // The rest are answered on the next tick (the answered ones are claimed already).
    const second = await poll(env);
    expect(second.replied).toBe(2);
    expect(sends).toHaveLength(6);
  });
});

describe('stale drafts whatever the completion order', () => {
  test('an older message whose draft finishes after a newer one is superseded and cannot be sent', async () => {
    const { env, sqlite, ai } = setupEnv();
    let release!: () => void;
    let reachedResolve!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const reached = new Promise<void>((r) => (reachedResolve = r));
    ai.state.handler = async (_model, inputs) => {
      if (Array.isArray(inputs.text)) {
        if ((inputs.text as string[]).some((t) => t.includes('Giá makeup?'))) {
          reachedResolve();
          await gate; // poll A is slow to answer the older message
        }
        return { data: inputs.text.map(() => new Array(1024).fill(0.01)) };
      }
      return { response: 'test answer' };
    };
    const messages: InboxMessage[] = [{ id: 'm1', direction: 'incoming', text: 'Giá makeup?', createdAt: future() }];
    const conversation = { updatedTime: future(60_000) };
    const { server, sends } = setupInbox(messages, conversation);
    await enable(env, server.url, 'draft');

    const pollA = poll(env);
    await reached;
    messages.unshift({ id: 'm2', direction: 'incoming', text: 'Còn lịch thứ 7 không?', createdAt: future(10_000) });
    conversation.updatedTime = future(70_000);
    expect((await poll(env)).drafted).toBe(1); // poll B answers the newer message first
    release();
    await pollA;

    const rows = sqlite.query('SELECT id, external_message_id AS ext, status FROM social_messages ORDER BY external_message_id').all() as Array<{
      id: string;
      ext: string;
      status: string;
    }>;
    expect(rows.map((r) => [r.ext, r.status])).toEqual([
      ['m1', 'superseded'],
      ['m2', 'draft'],
    ]);
    const stale = await api(env, `/api/social/messages/${rows[0]!.id}/send`, 'POST', {});
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('message_not_sendable');
    expect(sends).toHaveLength(0);
  });

  test('the platform message time orders messages, not the order the polls claimed them in', async () => {
    for (const draftOrder of [['old', 'new'], ['new', 'old']]) {
      const { env, sqlite } = setupEnv();
      const db = new Db(env.DB);
      sqlite.exec(`INSERT INTO social_conversations (id, account_id, conversation_id) VALUES ('c', 'acc-1', 'conv-1')`);
      // The newer message is claimed first (its poll listed the inbox later but ran ahead).
      const ids: Record<string, string> = {
        new: (await db.claimSocialMessage('c', 'm2', 'Còn lịch?', 2_000)) as string,
        old: (await db.claimSocialMessage('c', 'm1', 'Giá?', 1_000)) as string,
      };
      for (const which of draftOrder) await db.storeSocialDraft(ids[which]!, 'c', `answer ${which}`);

      expect((await db.getSocialMessage(ids.old!))?.status).toBe('superseded');
      expect((await db.getSocialMessage(ids.new!))?.status).toBe('draft');
    }
  });

  test('admin send refuses a draft when a newer customer message exists in the conversation', async () => {
    const OLD = 'a'.repeat(32);
    const { env, sqlite } = setupEnv();
    const { server, sends } = setupInbox([], { unreadCount: 0 });
    await enable(env, server.url, 'draft');
    sqlite.exec(`INSERT INTO social_conversations (id, account_id, conversation_id) VALUES ('c', 'acc-1', 'conv-1')`);
    sqlite.exec(`INSERT INTO social_messages (id, conversation_row_id, external_message_id, message_time, status, reply_text)
      VALUES ('${OLD}', 'c', 'm1', 1000, 'draft', 'Dạ 2 triệu ạ'), ('${'b'.repeat(32)}', 'c', 'm2', 2000, 'failed', NULL)`);

    const res = await api(env, `/api/social/messages/${OLD}/send`, 'POST', {});
    expect(res.status).toBe(409);
    expect(res.body.code).toBe('message_not_sendable');
    expect(sends).toHaveLength(0);
    expect(sqlite.query(`SELECT status FROM social_messages WHERE id = '${OLD}'`).get()).toEqual({ status: 'draft' });
  });
});
