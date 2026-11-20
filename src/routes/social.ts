/**
 * Admin routes for settings, the MCP connection and the social livechat inbox (all bearer-protected):
 *   GET/POST /api/settings
 *   POST     /api/mcp/test-connection
 *   GET      /api/social/conversations
 *   GET      /api/social/conversations/:id/messages
 *   POST     /api/social/conversations/:id/ai
 *   POST     /api/social/messages/:id/send
 *   POST     /api/social/poll
 */
import { Hono } from 'hono';
import { intVar, loadConfig } from '../config';
import { Db, type SocialConversationListRow, type SocialConversationRow, type SocialMessageRow } from '../db/schema';
import { readJson, requireAdmin } from '../http';
import {
  MAX_SOCIAL_REPLY_CHARS,
  createMcpClient,
  pollSocialInbox,
  sendSocialMessageAsAdmin,
} from '../services/social-agent';
import { loadSettings, parseSettingsPatch, saveSettings, toPublicSettings } from '../services/settings';
import { HttpError, type AppBindings } from '../types';

const ROW_ID_PATTERN = /^[a-f0-9]{32}$/;

function requireRowId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !ROW_ID_PATTERN.test(value)) {
    throw new HttpError(404, `${what} not found`, 'not_found');
  }
  return value;
}

function conversationView(row: SocialConversationRow | SocialConversationListRow) {
  const list = row as Partial<SocialConversationListRow>;
  return {
    id: row.id,
    accountId: row.account_id,
    conversationId: row.conversation_id,
    platform: row.platform,
    participantName: row.participant_name,
    aiEnabled: !!row.ai_enabled,
    status: row.status,
    lastMessageAt: row.last_message_at,
    updatedAt: row.updated_at,
    lastCustomerText: list.last_customer_text ?? null,
    lastReplyText: list.last_reply_text ?? null,
    lastReplyStatus: list.last_reply_status ?? null,
  };
}

function messageView(row: SocialMessageRow) {
  return {
    id: row.id,
    externalMessageId: row.external_message_id,
    customerText: row.customer_text,
    replyText: row.reply_text,
    status: row.status,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export const socialAdminRoutes = new Hono<AppBindings>();
const admin = socialAdminRoutes;
// Mounted at /api next to public routes, so the guard is scoped to this router's own paths.
admin.use('/settings', requireAdmin);
admin.use('/mcp/*', requireAdmin);
admin.use('/social/*', requireAdmin);

admin.get('/settings', async (c) => c.json(toPublicSettings(await loadSettings(c.env))));

admin.post('/settings', async (c) => {
  const patch = parseSettingsPatch(await readJson<unknown>(c));
  const db = new Db(c.env.DB);
  const saved = await saveSettings(c.env, patch, async (siteId) => !!(await db.getSite(siteId)));
  return c.json(toPublicSettings(saved));
});

/** Handshake + tools/list with the saved settings. Always HTTP 200; the error never contains the token. */
admin.post('/mcp/test-connection', async (c) => {
  const settings = await loadSettings(c.env);
  if (!settings.mcp.url) return c.json({ ok: false, error: 'MCP server URL is not set' });
  try {
    const client = createMcpClient(settings, c.env);
    const { serverName } = await client.initialize();
    const tools = await client.listTools();
    return c.json({ ok: true, serverName, tools: tools.map((t) => t.name) });
  } catch (err) {
    let message = err instanceof Error ? err.message : String(err);
    if (settings.mcp.token) message = message.split(settings.mcp.token).join('***');
    return c.json({ ok: false, error: message.slice(0, 300) });
  }
});

admin.get('/social/conversations', async (c) => {
  const status = c.req.query('status') ?? 'all';
  if (status !== 'open' && status !== 'needs_human' && status !== 'all') {
    throw new HttpError(400, 'status must be open, needs_human or all', 'invalid_status');
  }
  const limit = intVar(c.req.query('limit'), 50, 1, 200);
  const rows = await new Db(c.env.DB).listSocialConversations(status, limit);
  return c.json({ conversations: rows.map(conversationView) });
});

admin.get('/social/conversations/:id/messages', async (c) => {
  const id = requireRowId(c.req.param('id'), 'Conversation');
  const db = new Db(c.env.DB);
  if (!(await db.getSocialConversation(id))) throw new HttpError(404, 'Conversation not found', 'not_found');
  return c.json({ messages: (await db.listSocialMessages(id, 100)).map(messageView) });
});

admin.post('/social/conversations/:id/ai', async (c) => {
  const id = requireRowId(c.req.param('id'), 'Conversation');
  const body = await readJson<{ enabled?: unknown } | null>(c);
  if (typeof body?.enabled !== 'boolean') throw new HttpError(400, 'enabled must be a boolean', 'invalid_body');
  const row = await new Db(c.env.DB).setConversationAi(id, body.enabled);
  if (!row) throw new HttpError(404, 'Conversation not found', 'not_found');
  return c.json(conversationView(row));
});

admin.post('/social/messages/:id/send', async (c) => {
  const id = requireRowId(c.req.param('id'), 'Message');
  const body = (await readJson<{ text?: unknown; confirmUnknown?: unknown } | null>(c)) ?? {};
  let text: string | null = null;
  if (body.text !== undefined && body.text !== null) {
    if (typeof body.text !== 'string') throw new HttpError(400, 'text must be a string', 'invalid_body');
    const trimmed = body.text.trim();
    if (trimmed.length > MAX_SOCIAL_REPLY_CHARS) {
      throw new HttpError(400, `text must be at most ${MAX_SOCIAL_REPLY_CHARS} characters`, 'invalid_body');
    }
    text = trimmed || null;
  }
  if (body.confirmUnknown !== undefined && typeof body.confirmUnknown !== 'boolean') {
    throw new HttpError(400, 'confirmUnknown must be a boolean', 'invalid_body');
  }
  const settings = await loadSettings(c.env);
  const row = await sendSocialMessageAsAdmin(c.env, settings, id, text, { confirmUnknown: body.confirmUnknown === true });
  return c.json(messageView(row));
});

admin.post('/social/poll', async (c) => {
  const settings = await loadSettings(c.env);
  if (settings.mcp.socialMode === 'off') {
    throw new HttpError(409, 'Social replies are off; set mcp.socialMode to draft or auto first', 'social_off');
  }
  // Run under waitUntil so closing the tab does not cancel a poll midway; the response still awaits it.
  const run = pollSocialInbox(c.env, loadConfig(c.env), settings);
  c.executionCtx.waitUntil(run.catch(() => {}));
  return c.json(await run);
});
