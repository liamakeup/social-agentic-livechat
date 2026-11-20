/**
 * Social livechat agent: polls a social inbox through a remote MCP server (Zernio-shaped by default,
 * every tool name configurable), answers new customer messages with the site's RAG pipeline and either
 * sends the reply (mode "auto") or stores it as a draft for an admin (mode "draft").
 *
 * Exactly-once per customer message: a message is claimed by inserting its row into `social_messages`
 * (UNIQUE conversation + external message id). Only the poll whose insert created the row continues, so
 * overlapping cron ticks / manual polls never answer the same message twice. A send is never retried
 * automatically. Only a definite rejection becomes `failed` (safe to resend); a send whose outcome is
 * not known (timeout, network error, interrupted) becomes `unknown`, and an admin must confirm before
 * resending it. Rows a dead invocation left in `claimed` / `sending` are recovered at the next poll.
 */
import { ADMIN_SENDABLE_STATUSES, Db, type SocialConversationRow, type SocialMessageRow } from '../db/schema';
import { HttpError, type AppConfig, type ChatMessage, type Env } from '../types';
import { McpError, RemoteMcpClient, parseToolJson } from './mcp';
import { answerQuestion } from './rag';
import type { AppSettings } from './settings';

export interface PollSummary {
  /** Candidate conversations looked at (including the ones skipped without any MCP call). */
  checked: number;
  replied: number;
  drafted: number;
  handedOff: number;
  /** New customer messages recorded as needs_human in conversations whose AI is off (nothing generated). */
  needsHuman: number;
  skipped: number;
  /** Effective reply cap this tick: mcp.maxRepliesPerTick clamped to what the subrequest budget allows. */
  replyCap: number;
  /** Stale claimed / sending rows recovered at the start of the poll. */
  recovered: number;
  errors: string[];
}

/** Longest reply sent to a social platform (Messenger caps messages at 2000 characters). */
export const MAX_SOCIAL_REPLY_CHARS = 2000;
const MAX_CUSTOMER_TEXT_CHARS = 1000;
const HISTORY_MESSAGES = 6;
const LIST_LIMIT = 20;
const MESSAGES_LIMIT = 10;
/**
 * Subrequest budget. The Workers Free plan allows 50 subrequests per invocation, and the cron
 * invocation that polls the inbox also runs the crawler batch (its sitemap / page fetches share the
 * same 50), so the poll keeps to SUBREQUEST_BUDGET and leaves the rest as headroom for the crawler.
 * Calls are charged as they are made: 1 for a conversation's messages fetch, ANSWER_SUBREQUESTS once a
 * message is claimed for an AI answer, 1 for the send. A conversation needing an AI answer is started
 * only when the budget still covers all of it (SUBREQUESTS_PER_CONVERSATION). With the defaults this
 * caps AI replies at 4 per tick whatever mcp.maxRepliesPerTick says (see PollSummary.replyCap).
 */
const SUBREQUEST_BUDGET = 40;
/** initialize + initialized notification + list conversations (+1 for a session re-initialization). */
const SUBREQUESTS_PER_TICK = 4;
const MESSAGES_SUBREQUESTS = 1;
/** Embedding, vector query, rerank, generation, possible fallback generation and fallback headroom. */
const ANSWER_SUBREQUESTS = 6;
const SEND_SUBREQUESTS = 1;
const SUBREQUESTS_PER_CONVERSATION = MESSAGES_SUBREQUESTS + ANSWER_SUBREQUESTS + SEND_SUBREQUESTS;
/** `claimed` / `sending` rows older than this were left by an invocation that died; see recoverStaleSocialMessages. */
export const STALE_SOCIAL_MESSAGE_SECONDS = 5 * 60;
export const SEND_OUTCOME_UNKNOWN = 'send outcome unknown; check the platform before resending';

/** Most AI replies one tick can afford, whatever the configured cap. */
export function effectiveReplyCap(maxRepliesPerTick: number): number {
  const affordable = Math.floor((SUBREQUEST_BUDGET - SUBREQUESTS_PER_TICK) / SUBREQUESTS_PER_CONVERSATION);
  return Math.max(0, Math.min(maxRepliesPerTick, affordable));
}

/** Phrases meaning "let me talk to a person" (Vietnamese matched as substrings, English as words). */
const HANDOFF_PHRASES = ['nhân viên', 'người thật', 'tư vấn viên'];
const HANDOFF_WORDS = /\b(human|agent|staff)\b/i;

export function wantsHuman(text: string): boolean {
  const normalized = text.normalize('NFC').toLowerCase();
  return HANDOFF_PHRASES.some((p) => normalized.includes(p)) || HANDOFF_WORDS.test(normalized);
}

/** The MCP_SERVICE binding when the MCP URL's host is MCP_SERVICE_HOST, else undefined (public fetch). */
export function mcpTransport(url: string, env?: Pick<Env, 'MCP_SERVICE' | 'MCP_SERVICE_HOST'>): Fetcher | undefined {
  const host = env?.MCP_SERVICE_HOST?.trim().toLowerCase();
  if (!env?.MCP_SERVICE || !host) return undefined;
  try {
    return new URL(url).hostname.toLowerCase() === host ? env.MCP_SERVICE : undefined;
  } catch {
    return undefined;
  }
}

export function createMcpClient(settings: AppSettings, env?: Pick<Env, 'MCP_SERVICE' | 'MCP_SERVICE_HOST'>): RemoteMcpClient {
  return new RemoteMcpClient({
    fetcher: mcpTransport(settings.mcp.url, env),
    url: settings.mcp.url,
    token: settings.mcp.token || undefined,
    proxyTool: settings.mcp.proxyTool || undefined,
    sendTool: settings.mcp.toolSendMessage,
  });
}

// ---------------------------------------------------------------------------
// Defensive parsing of inbox tool payloads
// ---------------------------------------------------------------------------

export interface InboxConversation {
  id: string;
  accountId: string | null;
  platform: string | null;
  participantName: string | null;
  updatedTime: string | null;
  unreadCount: number;
}

export interface InboxMessage {
  id: string;
  direction: 'incoming' | 'outgoing' | null;
  text: string;
  /** Epoch milliseconds, or null when the payload had no usable timestamp. */
  time: number | null;
}

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function pick(obj: Obj, ...keys: string[]): unknown {
  for (const key of keys) {
    if (obj[key] !== undefined && obj[key] !== null) return obj[key];
  }
  return undefined;
}

function text(value: unknown): string | null {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return null;
}

/** Epoch ms from an ISO string or a unix timestamp (seconds or milliseconds). */
export function parseTime(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  if (typeof value === 'string' && value.trim()) {
    if (/^\d+$/.test(value.trim())) return parseTime(Number(value.trim()));
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : null;
  }
  return null;
}

/** The list inside a payload: the payload itself, or its data / conversations / messages / items field. */
function listOf(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isObj(payload)) {
    for (const key of ['data', 'conversations', 'messages', 'items', 'results']) {
      const value = payload[key];
      if (Array.isArray(value)) return value;
      if (isObj(value)) {
        const nested = listOf(value);
        if (nested.length > 0) return nested;
      }
    }
  }
  return [];
}

export function parseConversations(payload: unknown): InboxConversation[] {
  const out: InboxConversation[] = [];
  for (const item of listOf(payload)) {
    if (!isObj(item)) continue;
    const id = text(pick(item, 'id', 'conversationId', 'conversation_id'));
    if (!id) continue;
    const account = pick(item, 'accountId', 'account_id', 'account');
    const participant = pick(item, 'participantName', 'participant_name', 'participant');
    const unread = Number(pick(item, 'unreadCount', 'unread_count', 'unread') ?? 0);
    out.push({
      id,
      accountId: text(isObj(account) ? pick(account, 'id', '_id') : account),
      platform: text(pick(item, 'platform')),
      participantName: text(isObj(participant) ? pick(participant, 'name', 'username') : participant),
      updatedTime: text(pick(item, 'updatedTime', 'updated_time', 'updatedAt', 'lastMessageAt')),
      unreadCount: Number.isFinite(unread) ? unread : 0,
    });
  }
  return out;
}

export function parseMessages(payload: unknown): InboxMessage[] {
  const out: InboxMessage[] = [];
  for (const item of listOf(payload)) {
    if (!isObj(item)) continue;
    const id = text(pick(item, 'id', 'messageId', 'message_id', 'mid'));
    if (!id) continue;
    const direction = String(pick(item, 'direction') ?? '').toLowerCase();
    const body = pick(item, 'text', 'message', 'content', 'body');
    out.push({
      id,
      direction: direction === 'incoming' || direction === 'outgoing' ? direction : null,
      text: typeof body === 'string' ? body.trim() : '',
      time: parseTime(pick(item, 'createdAt', 'timestamp', 'created_time', 'createdTime', 'sentAt')),
    });
  }
  return out;
}

/** Messages newest first: by timestamp when every message has one, else in payload order (sort_order desc). */
function newestFirst(messages: InboxMessage[]): InboxMessage[] {
  if (messages.every((m) => m.time !== null)) {
    return [...messages].sort((a, b) => (b.time as number) - (a.time as number));
  }
  return messages;
}

function historyFrom(older: InboxMessage[]): ChatMessage[] {
  return older
    .filter((m) => m.direction !== null && m.text)
    .slice(0, HISTORY_MESSAGES)
    .reverse()
    .map((m) => ({ role: m.direction === 'incoming' ? 'user' : 'assistant', content: m.text }));
}

function errorMessage(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 300);
}

// ---------------------------------------------------------------------------
// Poll
// ---------------------------------------------------------------------------

/** One polling pass over the inbox. Never throws for per-conversation failures (they land in `errors`). */
export async function pollSocialInbox(
  env: Env,
  config: AppConfig,
  settings: AppSettings,
  client: RemoteMcpClient = createMcpClient(settings, env),
): Promise<PollSummary> {
  const mcp = settings.mcp;
  const summary: PollSummary = {
    checked: 0,
    replied: 0,
    drafted: 0,
    handedOff: 0,
    needsHuman: 0,
    skipped: 0,
    replyCap: effectiveReplyCap(mcp.maxRepliesPerTick),
    recovered: 0,
    errors: [],
  };
  if (mcp.socialMode === 'off') return summary;
  const db = new Db(env.DB);
  summary.recovered = await db.recoverStaleSocialMessages(STALE_SOCIAL_MESSAGE_SECONDS, SEND_OUTCOME_UNKNOWN);
  if (summary.recovered > 0) {
    console.warn(JSON.stringify({ event: 'social.recovered_stale', count: summary.recovered }));
  }
  if (!mcp.url) throw new HttpError(409, 'Set the MCP server URL first', 'mcp_not_configured');
  const enabledAt = parseTime(mcp.socialEnabledAt);
  if (enabledAt === null) throw new HttpError(409, 'Social replies have no start time; save the settings again', 'social_not_enabled');

  const site = mcp.socialSiteId ? await db.getSite(mcp.socialSiteId) : null;
  if (!site) throw new HttpError(409, `Social site "${mcp.socialSiteId}" is not registered`, 'site_not_found');

  const listArgs: Record<string, unknown> = { status: 'active', limit: LIST_LIMIT };
  if (mcp.accountId) listArgs.account_id = mcp.accountId;
  const conversations = parseConversations(parseToolJson(await client.callTool(mcp.toolListConversations, listArgs)));

  const candidates = conversations.filter((c) => {
    if (c.unreadCount <= 0) return false;
    const updated = parseTime(c.updatedTime);
    return updated === null || updated >= enabledAt;
  });

  const tick: Tick = { budget: SUBREQUEST_BUDGET - SUBREQUESTS_PER_TICK, claims: 0, replyCap: summary.replyCap };
  for (const conversation of candidates) {
    if (tick.claims >= tick.replyCap || tick.budget < MESSAGES_SUBREQUESTS) break;
    try {
      const outcome = await handleConversation(env, config, settings, client, db, site, conversation, enabledAt, tick);
      if (outcome === 'stop') break;
      summary.checked++;
      summary[outcome]++;
    } catch (err) {
      summary.checked++;
      summary.errors.push(`${conversation.id}: ${errorMessage(err)}`);
      console.error(JSON.stringify({ event: 'social.conversation_failed', conversation: conversation.id, message: errorMessage(err) }));
    }
  }
  console.log(
    JSON.stringify({
      event: 'social.poll',
      mode: mcp.socialMode,
      ...summary,
      maxRepliesPerTick: mcp.maxRepliesPerTick,
      budgetLeft: tick.budget,
      errors: summary.errors.length,
    }),
  );
  return summary;
}

/** Per-tick accounting: subrequests left and conversations that reached an AI claim. */
interface Tick {
  budget: number;
  claims: number;
  replyCap: number;
}

/** `stop`: the budget cannot cover this conversation; the tick ends without touching it. */
type Outcome = 'replied' | 'drafted' | 'handedOff' | 'needsHuman' | 'skipped' | 'stop';

async function handleConversation(
  env: Env,
  config: AppConfig,
  settings: AppSettings,
  client: RemoteMcpClient,
  db: Db,
  site: { id: string; domain: string },
  item: InboxConversation,
  enabledAt: number,
  tick: Tick,
): Promise<Outcome> {
  const mcp = settings.mcp;
  const accountId = item.accountId ?? mcp.accountId;
  if (!accountId) throw new McpError('Conversation has no account id; set mcp.accountId');

  // Nothing happened since this conversation was last processed: skip without any MCP call.
  const stored = await db.getSocialConversationByExternal(accountId, item.id);
  if (stored && item.updatedTime !== null && stored.last_message_at === item.updatedTime) return 'skipped';

  const aiEnabled = stored ? !!stored.ai_enabled : true;
  // An AI answer is started only when the whole conversation fits the budget; an AI-off one needs one call.
  if (tick.budget < (aiEnabled ? SUBREQUESTS_PER_CONVERSATION : MESSAGES_SUBREQUESTS)) return 'stop';

  const conversation = await db.upsertSocialConversation({
    accountId,
    conversationId: item.id,
    platform: item.platform,
    participantName: item.participantName,
  });
  const outcome = await handleNewActivity(env, config, settings, client, db, site, conversation, enabledAt, tick);
  // Recorded only after processing, so a conversation that failed midway is looked at again next tick.
  if (item.updatedTime !== null) await db.markSocialConversationSeen(conversation.id, item.updatedTime);
  return outcome;
}

async function handleNewActivity(
  env: Env,
  config: AppConfig,
  settings: AppSettings,
  client: RemoteMcpClient,
  db: Db,
  site: { id: string; domain: string },
  conversation: SocialConversationRow,
  enabledAt: number,
  tick: Tick,
): Promise<Outcome> {
  const mcp = settings.mcp;
  tick.budget -= MESSAGES_SUBREQUESTS;
  const payload = await client.callTool(mcp.toolListMessages, {
    conversation_id: conversation.conversation_id,
    account_id: conversation.account_id,
    sort_order: 'desc',
    limit: MESSAGES_LIMIT,
  });
  const [latest, ...older] = newestFirst(parseMessages(parseToolJson(payload)));
  // Only a customer message written after social replies were switched on is ever answered.
  if (!latest || latest.direction !== 'incoming' || !latest.text) return 'skipped';
  if (latest.time === null || latest.time < enabledAt) return 'skipped';

  const customerText = latest.text.slice(0, MAX_CUSTOMER_TEXT_CHARS);
  if (!conversation.ai_enabled) {
    // AI is off (handed off or switched off): record the message for a human, generate nothing.
    const recorded = await db.claimSocialMessage(conversation.id, latest.id, customerText, latest.time, 'needs_human');
    return recorded ? 'needsHuman' : 'skipped';
  }

  const messageId = await db.claimSocialMessage(conversation.id, latest.id, customerText, latest.time);
  if (!messageId) return 'skipped'; // Already handled (or being handled) by another poll.
  tick.claims++;

  if (wantsHuman(customerText)) return handOff(db, conversation, messageId);

  let answer: string;
  tick.budget -= ANSWER_SUBREQUESTS;
  try {
    const result = await answerQuestion(env, config, settings, site, customerText, historyFrom(older));
    if (result.chunks.length === 0) return handOff(db, conversation, messageId);
    answer = result.answer.slice(0, MAX_SOCIAL_REPLY_CHARS).trim();
    if (!answer) throw new Error('The model returned an empty answer');
  } catch (err) {
    await db.transitionSocialMessage(messageId, 'claimed', 'failed', null, `Generation failed: ${errorMessage(err)}`);
    throw err;
  }

  if (mcp.socialMode === 'draft') {
    await db.storeSocialDraft(messageId, conversation.id, answer);
    return 'drafted';
  }

  if (!(await db.transitionSocialMessage(messageId, 'claimed', 'sending', answer))) return 'skipped';
  tick.budget -= SEND_SUBREQUESTS;
  const delivery = await deliver(db, client, settings, conversation, messageId, answer);
  if (delivery.status !== 'sent') throw new McpError(delivery.error);
  return 'replied';
}

async function handOff(db: Db, conversation: SocialConversationRow, messageId: string): Promise<Outcome> {
  await db.handOffSocialMessage(messageId, conversation.id);
  return 'handedOff';
}

type Delivery = { status: 'sent' } | { status: 'failed' | 'unknown'; error: string };

/**
 * Send a reply for a message already in "sending" and record the outcome (never retried automatically):
 * - delivered → `sent`;
 * - definitely rejected (HTTP 4xx, JSON-RPC error, tool isError) or never sent (handshake failed) → `failed`;
 * - anything else (timeout, network error, 5xx, unreadable answer) → `unknown`.
 * The D1 write after a successful send is outside the send's error handling: if it fails, the row stays
 * in `sending` and the next poll recovers it as `unknown`, never as a resendable failure.
 */
async function deliver(
  db: Db,
  client: RemoteMcpClient,
  settings: AppSettings,
  conversation: SocialConversationRow,
  messageId: string,
  reply: string,
): Promise<Delivery> {
  try {
    await client.callTool(settings.mcp.toolSendMessage, {
      conversation_id: conversation.conversation_id,
      account_id: conversation.account_id,
      message: reply,
    });
  } catch (err) {
    const definite = err instanceof McpError && !err.uncertain;
    const outcome: Delivery = definite
      ? { status: 'failed', error: errorMessage(err) }
      : { status: 'unknown', error: `${SEND_OUTCOME_UNKNOWN} (${errorMessage(err)})` };
    await record(messageId, () => db.transitionSocialMessage(messageId, 'sending', outcome.status, null, outcome.error));
    return outcome;
  }
  await record(messageId, () => db.transitionSocialMessage(messageId, 'sending', 'sent'));
  return { status: 'sent' };
}

/** Run a status write; a failure is logged and leaves the row in `sending` for the stale-row recovery. */
async function record(messageId: string, write: () => Promise<unknown>): Promise<void> {
  try {
    await write();
  } catch (err) {
    console.error(JSON.stringify({ event: 'social.record_failed', message_id: messageId, message: errorMessage(err) }));
  }
}

// ---------------------------------------------------------------------------
// Admin send
// ---------------------------------------------------------------------------

/**
 * Send a draft / failed / needs_human message by hand, optionally with edited text. An `unknown` message
 * (its earlier send may have reached the customer) is sent only with `confirmUnknown`. The atomic
 * UPDATE … status='sending' claim means two concurrent calls send at most once (the second gets 409).
 */
export async function sendSocialMessageAsAdmin(
  env: Env,
  settings: AppSettings,
  messageId: string,
  replyText: string | null,
  options: { confirmUnknown?: boolean } = {},
  client: RemoteMcpClient = createMcpClient(settings, env),
): Promise<SocialMessageRow> {
  if (!settings.mcp.url) throw new HttpError(409, 'Set the MCP server URL first', 'mcp_not_configured');
  const db = new Db(env.DB);
  const claimed = await db.claimSocialMessageForAdmin(messageId, replyText, options.confirmUnknown === true);
  if (!claimed) {
    const existing = await db.getSocialMessage(messageId);
    if (!existing) throw new HttpError(404, 'Message not found', 'message_not_found');
    if (existing.status === 'unknown' && options.confirmUnknown !== true) {
      throw new HttpError(
        409,
        'The earlier send of this message may have reached the customer; check the platform, then resend with confirmUnknown: true',
        'confirm_required',
      );
    }
    if (existing.status === 'draft' && (await db.hasNewerSocialMessage(messageId))) {
      throw new HttpError(409, 'A newer customer message exists; this draft answers an outdated question', 'message_not_sendable');
    }
    if ([...ADMIN_SENDABLE_STATUSES, 'unknown'].includes(existing.status)) {
      throw new HttpError(400, 'text is required: this message has no reply yet', 'text_required');
    }
    throw new HttpError(409, `Message is ${existing.status} and cannot be sent`, 'message_not_sendable');
  }
  const conversation = await db.getSocialConversation(claimed.conversation_row_id);
  if (!conversation) {
    await db.transitionSocialMessage(messageId, 'sending', 'failed', null, 'Conversation not found');
  } else {
    await deliver(db, client, settings, conversation, messageId, claimed.reply_text as string);
  }
  return (await db.getSocialMessage(messageId)) as SocialMessageRow;
}
