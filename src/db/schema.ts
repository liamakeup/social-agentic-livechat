/**
 * D1 data access layer: row interfaces, SQL statements and a thin repository class.
 * Schema lives in migrations/ (0000_init.sql, 0001_queue_lease.sql, 0002_social_livechat.sql).
 */
import type { IndexProgress } from '../types';

export type PageStatus = 'pending' | 'processing' | 'indexed' | 'failed';

export interface SiteRow {
  id: string;
  domain: string;
  sitemap_url: string;
  created_at: string;
}

export interface PageRow {
  id: string;
  site_id: string;
  url: string;
  title: string | null;
  chunk_count: number;
  status: PageStatus;
  error: string | null;
  /** Number of times the page was claimed for indexing since it was last queued. */
  attempts: number;
  updated_at: string;
}

export interface QueryRow {
  id: string;
  site_id: string;
  prompt: string;
  response: string | null;
  created_at: string;
}

export type KnowledgeCategory = 'pricing' | 'faq' | 'policy' | 'general';

export interface KnowledgeDocRow {
  id: string;
  site_id: string;
  title: string;
  content: string;
  category: KnowledgeCategory;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

/** Knowledge doc listing row: no content, its length instead. */
export type KnowledgeDocSummary = Omit<KnowledgeDocRow, 'content'> & { content_length: number };

/**
 * claimed → draft | superseded | sending | needs_human | failed; sending → sent | failed | unknown;
 * draft → superseded once a newer customer message of the same conversation exists (by message_time). `unknown`: the send may or may not have
 * reached the customer (timeout, network error, interrupted); an admin must check before resending.
 */
export type SocialMessageStatus =
  | 'claimed'
  | 'draft'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'needs_human'
  | 'unknown'
  | 'superseded';

export interface SocialConversationRow {
  id: string;
  account_id: string;
  conversation_id: string;
  platform: string | null;
  participant_name: string | null;
  ai_enabled: number;
  status: 'open' | 'needs_human';
  last_message_at: string | null;
  updated_at: string;
}

export interface SocialConversationListRow extends SocialConversationRow {
  last_customer_text: string | null;
  last_reply_text: string | null;
  last_reply_status: SocialMessageStatus | null;
}

export interface SocialMessageRow {
  id: string;
  conversation_row_id: string;
  external_message_id: string;
  /** Platform time of the customer message (epoch ms). */
  message_time: number | null;
  customer_text: string | null;
  reply_text: string | null;
  status: SocialMessageStatus;
  error: string | null;
  created_at: string;
  updated_at: string;
}

/** Statuses an admin may (re)send by hand; `unknown` too, but only with an explicit confirmation. */
export const ADMIN_SENDABLE_STATUSES: readonly SocialMessageStatus[] = ['draft', 'failed', 'needs_human'];

/**
 * Order of the customer messages of a conversation: platform message time, then insertion order. The
 * claim order of overlapping polls never decides which message is newer.
 */
const MESSAGE_ORDER = (table: string) => `(COALESCE(${table}.message_time, 0), ${table}.rowid)`;

/** True when a newer customer message than the `outer` row exists in the same conversation. */
const NEWER_MESSAGE_EXISTS = (outer: string) => `EXISTS (
      SELECT 1 FROM social_messages AS newer
      WHERE newer.conversation_row_id = ${outer}.conversation_row_id AND ${MESSAGE_ORDER('newer')} > ${MESSAGE_ORDER(outer)})`;

/** All SQL in one place so it is easy to audit. Positional parameters use ?1, ?2, ... */
export const SQL = {
  upsertSite: `
    INSERT INTO sites (id, domain, sitemap_url)
    VALUES (?1, ?2, ?3)
    ON CONFLICT (id) DO UPDATE SET domain = excluded.domain, sitemap_url = excluded.sitemap_url`,
  getSite: `SELECT * FROM sites WHERE id = ?1`,
  listSites: `SELECT * FROM sites ORDER BY created_at DESC`,
  deleteSite: `DELETE FROM sites WHERE id = ?1`,

  /**
   * Insert a page or reset an existing one back to the queue. Keyed on (site_id, url) rather than the
   * id, so rows created before page ids included the site id keep their id (and their vectors).
   */
  enqueuePage: `
    INSERT INTO pages (id, site_id, url, status, error, attempts, updated_at)
    VALUES (?1, ?2, ?3, 'pending', NULL, 0, CURRENT_TIMESTAMP)
    ON CONFLICT (site_id, url) DO UPDATE SET
      status = 'pending', error = NULL, attempts = 0, updated_at = CURRENT_TIMESTAMP`,
  /**
   * Atomically claim the next pages: pending ones, plus "processing" ones whose lease expired (the
   * invocation that claimed them died). A single UPDATE is atomic in D1, so concurrent cron ticks and
   * /process calls never receive the same page. The claim refreshes `updated_at`, which starts the lease.
   * ?1 site, ?2 limit, ?3 lease modifier ("-15 minutes").
   */
  claimPendingForSite: `
    UPDATE pages SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM pages
      WHERE site_id = ?1
        AND (status = 'pending' OR (status = 'processing' AND updated_at < datetime('now', ?3)))
      ORDER BY updated_at ASC LIMIT ?2)
    RETURNING *`,
  /** Same as claimPendingForSite across all sites. ?1 limit, ?2 lease modifier. */
  claimPendingAny: `
    UPDATE pages SET status = 'processing', attempts = attempts + 1, updated_at = CURRENT_TIMESTAMP
    WHERE id IN (
      SELECT id FROM pages
      WHERE status = 'pending' OR (status = 'processing' AND updated_at < datetime('now', ?2))
      ORDER BY updated_at ASC LIMIT ?1)
    RETURNING *`,
  /** Hand a claimed page back to the queue without counting the attempt (e.g. Workers AI rate limit). */
  releasePage: `
    UPDATE pages SET status = 'pending', attempts = MAX(attempts - 1, 0) WHERE id = ?1 AND status = 'processing'`,
  markPageIndexed: `
    UPDATE pages SET title = ?2, chunk_count = ?3, status = 'indexed', error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1`,
  markPageFailed: `
    UPDATE pages SET status = 'failed', error = ?2, updated_at = CURRENT_TIMESTAMP WHERE id = ?1`,
  pageStats: `SELECT status, COUNT(*) AS n FROM pages WHERE site_id = ?1 GROUP BY status`,
  pageStatsAll: `SELECT site_id, status, COUNT(*) AS n FROM pages GROUP BY site_id, status`,
  listPages: `SELECT id, url, chunk_count FROM pages WHERE site_id = ?1`,
  listPageVectors: `SELECT id, chunk_count FROM pages WHERE site_id = ?1 AND chunk_count > 0`,
  deletePage: `DELETE FROM pages WHERE id = ?1`,
  deletePagesForSite: `DELETE FROM pages WHERE site_id = ?1`,

  insertQuery: `INSERT INTO queries (id, site_id, prompt, response) VALUES (?1, ?2, ?3, ?4)`,
  listQueries: `
    SELECT id, site_id, prompt, response, created_at FROM queries
    WHERE site_id = ?1 ORDER BY created_at DESC LIMIT ?2`,
  countQueriesSince: `SELECT COUNT(*) AS n FROM queries WHERE site_id = ?1 AND created_at >= datetime('now', ?2)`,
  pruneQueries: `DELETE FROM queries WHERE created_at < datetime('now', ?1)`,
  deleteQueriesForSite: `DELETE FROM queries WHERE site_id = ?1`,

  insertKnowledgeDoc: `
    INSERT INTO knowledge_docs (id, site_id, title, content, category, chunk_count)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)`,
  /** Saves only touch a doc no delete has started on (deleting = 0); see markKnowledgeDocDeleting. */
  updateKnowledgeDoc: `
    UPDATE knowledge_docs SET title = ?3, content = ?4, category = ?5, chunk_count = ?6, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1 AND site_id = ?2 AND deleting = 0`,
  setKnowledgeChunkCount: `
    UPDATE knowledge_docs SET chunk_count = ?3, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1 AND site_id = ?2 AND deleting = 0`,
  getKnowledgeDoc: `SELECT * FROM knowledge_docs WHERE id = ?1 AND site_id = ?2 AND deleting = 0`,
  /**
   * First step of a delete: flag the doc and read the vector range it tracks, in one statement. From
   * then on no save can raise chunk_count or finish, so a save in flight discards its own vectors.
   */
  markKnowledgeDocDeleting: `
    UPDATE knowledge_docs SET deleting = 1 WHERE id = ?1 AND site_id = ?2 RETURNING chunk_count`,
  listKnowledgeDocs: `
    SELECT id, site_id, title, category, chunk_count, length(content) AS content_length, created_at, updated_at
    FROM knowledge_docs WHERE site_id = ?1 ORDER BY updated_at DESC, title`,
  /** Site removal: flag every doc of the site as being deleted and return the vector range each tracks. */
  markKnowledgeForSiteDeletion: `UPDATE knowledge_docs SET deleting = 1 WHERE site_id = ?1 RETURNING id, chunk_count`,
  deleteKnowledgeDoc: `DELETE FROM knowledge_docs WHERE id = ?1 AND site_id = ?2`,
  deleteKnowledgeForSite: `DELETE FROM knowledge_docs WHERE site_id = ?1`,

  /**
   * Insert a conversation or refresh its display fields; ai_enabled / status / last_message_at are left
   * alone (last_message_at is recorded only once the conversation was processed, see markSocialConversationSeen).
   */
  upsertSocialConversation: `
    INSERT INTO social_conversations (id, account_id, conversation_id, platform, participant_name)
    VALUES (?1, ?2, ?3, ?4, ?5)
    ON CONFLICT (account_id, conversation_id) DO UPDATE SET
      platform = COALESCE(excluded.platform, social_conversations.platform),
      participant_name = COALESCE(excluded.participant_name, social_conversations.participant_name),
      updated_at = CURRENT_TIMESTAMP
    RETURNING *`,
  getSocialConversation: `SELECT * FROM social_conversations WHERE id = ?1`,
  getSocialConversationByExternal: `SELECT * FROM social_conversations WHERE account_id = ?1 AND conversation_id = ?2`,
  /** The inbox's updatedTime of the last processed state; equal on the next poll = nothing new. */
  markSocialConversationSeen: `UPDATE social_conversations SET last_message_at = ?2 WHERE id = ?1`,
  listSocialConversations: `
    SELECT c.*, m.customer_text AS last_customer_text, m.reply_text AS last_reply_text, m.status AS last_reply_status
    FROM social_conversations c
    LEFT JOIN social_messages m ON m.id = (
      SELECT id FROM social_messages WHERE conversation_row_id = c.id
      ORDER BY COALESCE(message_time, 0) DESC, rowid DESC LIMIT 1)
    WHERE ?1 = 'all' OR c.status = ?1
    ORDER BY c.updated_at DESC LIMIT ?2`,
  setConversationAi: `
    UPDATE social_conversations
    SET ai_enabled = ?2, status = CASE WHEN ?2 = 1 THEN 'open' ELSE status END, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1 RETURNING *`,
  handOffConversation: `
    UPDATE social_conversations SET ai_enabled = 0, status = 'needs_human', updated_at = CURRENT_TIMESTAMP WHERE id = ?1`,
  /** The idempotency claim: inserts nothing when this customer message already has a row. */
  claimSocialMessage: `
    INSERT INTO social_messages (id, conversation_row_id, external_message_id, customer_text, status, message_time)
    VALUES (?1, ?2, ?3, ?4, ?5, ?6)
    ON CONFLICT (conversation_row_id, external_message_id) DO NOTHING`,
  /** Drafts of a conversation older than message ?2 answer an outdated question: superseded. */
  supersedeOlderDrafts: `
    UPDATE social_messages SET status = 'superseded', updated_at = CURRENT_TIMESTAMP
    WHERE conversation_row_id = ?1 AND status = 'draft' AND id <> ?2
      AND ${MESSAGE_ORDER('social_messages')} < (SELECT COALESCE(message_time, 0), rowid FROM social_messages WHERE id = ?2)`,
  /**
   * Store a claimed message's generated reply: `draft`, or straight `superseded` when a newer customer
   * message of the conversation already exists (its poll may have finished first).
   */
  storeSocialDraft: `
    UPDATE social_messages
    SET status = CASE WHEN ${NEWER_MESSAGE_EXISTS('social_messages')} THEN 'superseded' ELSE 'draft' END,
      reply_text = ?2, error = NULL, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1 AND status = 'claimed'`,
  hasNewerSocialMessage: `SELECT ${NEWER_MESSAGE_EXISTS('social_messages')} AS newer FROM social_messages WHERE id = ?1`,
  /** A claim whose poll died before sending: nothing was sent, so a resend is safe. */
  recoverStaleClaimed: `
    UPDATE social_messages SET status = 'failed', error = 'interrupted before send', updated_at = CURRENT_TIMESTAMP
    WHERE status = 'claimed' AND updated_at < datetime('now', ?1)`,
  /** A send whose outcome was never recorded: it may have reached the customer. */
  recoverStaleSending: `
    UPDATE social_messages SET status = 'unknown', error = ?2, updated_at = CURRENT_TIMESTAMP
    WHERE status = 'sending' AND updated_at < datetime('now', ?1)`,
  /** Move a message between states only from the expected one (compare-and-set). */
  transitionSocialMessage: `
    UPDATE social_messages SET status = ?3, reply_text = COALESCE(?4, reply_text), error = ?5, updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1 AND status = ?2`,
  /**
   * Admin send claim: one atomic UPDATE takes a draft/failed/needs_human message (or an unknown one when
   * ?3 = 1, the admin confirmed it) to "sending" with the edited text, if any. A second concurrent call
   * finds it in "sending" and updates nothing. A draft is refused once a newer customer message exists.
   */
  claimSocialMessageForAdmin: `
    UPDATE social_messages SET status = 'sending', reply_text = COALESCE(?2, reply_text), error = NULL,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?1 AND (status IN ('draft', 'failed', 'needs_human') OR (?3 = 1 AND status = 'unknown'))
      AND NOT (status = 'draft' AND ${NEWER_MESSAGE_EXISTS('social_messages')})
      AND length(trim(COALESCE(?2, reply_text, ''))) > 0
    RETURNING *`,
  getSocialMessage: `SELECT * FROM social_messages WHERE id = ?1`,
  listSocialMessages: `
    SELECT * FROM (
      SELECT *, rowid AS seq FROM social_messages WHERE conversation_row_id = ?1
      ORDER BY COALESCE(message_time, 0) DESC, rowid DESC LIMIT ?2
    ) ORDER BY COALESCE(message_time, 0) ASC, seq ASC`,
} as const;

/** D1 limits the number of bound parameters per statement; keep batches modest. */
const BATCH_SIZE = 50;

/** Progress with every counter at zero. */
export function emptyProgress(siteId: string): IndexProgress {
  return { siteId, total: 0, pending: 0, processing: 0, indexed: 0, failed: 0 };
}

function addCount(progress: IndexProgress, status: string, n: number): void {
  if (status === 'pending' || status === 'processing' || status === 'indexed' || status === 'failed') {
    progress[status] += n;
    progress.total += n;
  }
}

export class Db {
  constructor(private readonly d1: D1Database) {}

  // --- sites ---------------------------------------------------------------

  async upsertSite(id: string, domain: string, sitemapUrl: string): Promise<void> {
    await this.d1.prepare(SQL.upsertSite).bind(id, domain, sitemapUrl).run();
  }

  async getSite(id: string): Promise<SiteRow | null> {
    return this.d1.prepare(SQL.getSite).bind(id).first<SiteRow>();
  }

  async listSites(): Promise<SiteRow[]> {
    const { results } = await this.d1.prepare(SQL.listSites).all<SiteRow>();
    return results;
  }

  /** Remove a site together with its pages, knowledge docs and chat history. */
  async deleteSite(id: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare(SQL.deleteQueriesForSite).bind(id),
      this.d1.prepare(SQL.deleteKnowledgeForSite).bind(id),
      this.d1.prepare(SQL.deletePagesForSite).bind(id),
      this.d1.prepare(SQL.deleteSite).bind(id),
    ]);
  }

  // --- pages ---------------------------------------------------------------

  /** Queue URLs for crawling. Existing rows are reset to "pending" so re-indexing refreshes content. */
  async enqueuePages(siteId: string, pages: Array<{ id: string; url: string }>): Promise<void> {
    for (let i = 0; i < pages.length; i += BATCH_SIZE) {
      const slice = pages.slice(i, i + BATCH_SIZE);
      await this.d1.batch(slice.map((p) => this.d1.prepare(SQL.enqueuePage).bind(p.id, siteId, p.url)));
    }
  }

  /**
   * Claim up to `limit` pages for indexing (one site, or all sites when siteId is null). Claimed pages
   * are "processing" until marked indexed/failed or released; after `leaseMinutes` they are claimable
   * again, which recovers pages whose invocation was killed mid-crawl.
   */
  async claimPending(siteId: string | null, limit: number, leaseMinutes: number): Promise<PageRow[]> {
    const lease = `-${leaseMinutes} minutes`;
    const stmt = siteId
      ? this.d1.prepare(SQL.claimPendingForSite).bind(siteId, limit, lease)
      : this.d1.prepare(SQL.claimPendingAny).bind(limit, lease);
    const { results } = await stmt.all<PageRow>();
    return results;
  }

  /** Return claimed pages to the queue without counting the attempt. */
  async releasePages(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      await this.d1.batch(ids.slice(i, i + BATCH_SIZE).map((id) => this.d1.prepare(SQL.releasePage).bind(id)));
    }
  }

  async markPageIndexed(id: string, title: string, chunkCount: number): Promise<void> {
    await this.d1.prepare(SQL.markPageIndexed).bind(id, title, chunkCount).run();
  }

  async markPageFailed(id: string, error: string): Promise<void> {
    await this.d1.prepare(SQL.markPageFailed).bind(id, error.slice(0, 500)).run();
  }

  async progress(siteId: string): Promise<IndexProgress> {
    const { results } = await this.d1
      .prepare(SQL.pageStats)
      .bind(siteId)
      .all<{ status: PageStatus; n: number }>();
    const progress = emptyProgress(siteId);
    for (const row of results) addCount(progress, row.status, row.n);
    return progress;
  }

  /** Progress for every site in one query, keyed by site id. */
  async progressAll(): Promise<Map<string, IndexProgress>> {
    const { results } = await this.d1
      .prepare(SQL.pageStatsAll)
      .all<{ site_id: string; status: PageStatus; n: number }>();
    const map = new Map<string, IndexProgress>();
    for (const row of results) {
      const entry = map.get(row.site_id) ?? emptyProgress(row.site_id);
      addCount(entry, row.status, row.n);
      map.set(row.site_id, entry);
    }
    return map;
  }

  async listPages(siteId: string): Promise<Array<{ id: string; url: string; chunk_count: number }>> {
    const { results } = await this.d1
      .prepare(SQL.listPages)
      .bind(siteId)
      .all<{ id: string; url: string; chunk_count: number }>();
    return results;
  }

  async listPageVectors(siteId: string): Promise<Array<{ id: string; chunk_count: number }>> {
    const { results } = await this.d1
      .prepare(SQL.listPageVectors)
      .bind(siteId)
      .all<{ id: string; chunk_count: number }>();
    return results;
  }

  async deletePages(ids: string[]): Promise<void> {
    for (let i = 0; i < ids.length; i += BATCH_SIZE) {
      await this.d1.batch(ids.slice(i, i + BATCH_SIZE).map((id) => this.d1.prepare(SQL.deletePage).bind(id)));
    }
  }

  // --- queries -------------------------------------------------------------

  async logQuery(id: string, siteId: string, prompt: string, response: string): Promise<void> {
    await this.d1.prepare(SQL.insertQuery).bind(id, siteId, prompt, response).run();
  }

  async listQueries(siteId: string, limit: number): Promise<QueryRow[]> {
    const { results } = await this.d1.prepare(SQL.listQueries).bind(siteId, limit).all<QueryRow>();
    return results;
  }

  /** Chat log rows written for a site in the last `hours` hours. */
  async countQueriesSince(siteId: string, hours: number): Promise<number> {
    const row = await this.d1
      .prepare(SQL.countQueriesSince)
      .bind(siteId, `-${hours} hours`)
      .first<{ n: number }>();
    return row?.n ?? 0;
  }

  /** Delete chat log rows older than `days` days. Returns the number of rows removed. */
  async pruneQueries(days: number): Promise<number> {
    const result = await this.d1.prepare(SQL.pruneQueries).bind(`-${days} days`).run();
    return result.meta?.changes ?? 0;
  }
  // --- knowledge docs ------------------------------------------------------

  async insertKnowledgeDoc(doc: Omit<KnowledgeDocRow, 'created_at' | 'updated_at'>): Promise<void> {
    await this.d1
      .prepare(SQL.insertKnowledgeDoc)
      .bind(doc.id, doc.site_id, doc.title, doc.content, doc.category, doc.chunk_count)
      .run();
  }

  /** Returns false when the doc is gone or being deleted (nothing was written). */
  async updateKnowledgeDoc(doc: Omit<KnowledgeDocRow, 'created_at' | 'updated_at'>): Promise<boolean> {
    const result = await this.d1
      .prepare(SQL.updateKnowledgeDoc)
      .bind(doc.id, doc.site_id, doc.title, doc.content, doc.category, doc.chunk_count)
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  /** Returns false when the doc is gone or being deleted (nothing was written). */
  async setKnowledgeChunkCount(siteId: string, id: string, chunkCount: number): Promise<boolean> {
    const result = await this.d1.prepare(SQL.setKnowledgeChunkCount).bind(id, siteId, chunkCount).run();
    return (result.meta?.changes ?? 0) === 1;
  }

  /** Flag a doc as being deleted; returns its chunk_count, or null when there is no such doc. */
  async markKnowledgeDocDeleting(siteId: string, id: string): Promise<number | null> {
    const row = await this.d1.prepare(SQL.markKnowledgeDocDeleting).bind(id, siteId).first<{ chunk_count: number }>();
    return row ? row.chunk_count : null;
  }

  async getKnowledgeDoc(siteId: string, id: string): Promise<KnowledgeDocRow | null> {
    return this.d1.prepare(SQL.getKnowledgeDoc).bind(id, siteId).first<KnowledgeDocRow>();
  }

  async listKnowledgeDocs(siteId: string): Promise<KnowledgeDocSummary[]> {
    const { results } = await this.d1.prepare(SQL.listKnowledgeDocs).bind(siteId).all<KnowledgeDocSummary>();
    return results;
  }

  /** Flag every knowledge doc of a site as being deleted; returns the ones that own vectors. */
  async markKnowledgeForSiteDeletion(siteId: string): Promise<Array<{ id: string; chunk_count: number }>> {
    const { results } = await this.d1
      .prepare(SQL.markKnowledgeForSiteDeletion)
      .bind(siteId)
      .all<{ id: string; chunk_count: number }>();
    return results.filter((doc) => doc.chunk_count > 0);
  }

  async deleteKnowledgeDoc(siteId: string, id: string): Promise<void> {
    await this.d1.prepare(SQL.deleteKnowledgeDoc).bind(id, siteId).run();
  }

  // --- social livechat -----------------------------------------------------

  async upsertSocialConversation(conv: {
    accountId: string;
    conversationId: string;
    platform: string | null;
    participantName: string | null;
  }): Promise<SocialConversationRow> {
    const row = await this.d1
      .prepare(SQL.upsertSocialConversation)
      .bind(newId(), conv.accountId, conv.conversationId, conv.platform, conv.participantName)
      .first<SocialConversationRow>();
    if (!row) throw new Error('Conversation upsert returned no row');
    return row;
  }

  async getSocialConversation(id: string): Promise<SocialConversationRow | null> {
    return this.d1.prepare(SQL.getSocialConversation).bind(id).first<SocialConversationRow>();
  }

  async getSocialConversationByExternal(accountId: string, conversationId: string): Promise<SocialConversationRow | null> {
    return this.d1
      .prepare(SQL.getSocialConversationByExternal)
      .bind(accountId, conversationId)
      .first<SocialConversationRow>();
  }

  async markSocialConversationSeen(id: string, lastMessageAt: string): Promise<void> {
    await this.d1.prepare(SQL.markSocialConversationSeen).bind(id, lastMessageAt).run();
  }

  async listSocialConversations(
    status: 'open' | 'needs_human' | 'all',
    limit: number,
  ): Promise<SocialConversationListRow[]> {
    const { results } = await this.d1
      .prepare(SQL.listSocialConversations)
      .bind(status, limit)
      .all<SocialConversationListRow>();
    return results;
  }

  async setConversationAi(id: string, enabled: boolean): Promise<SocialConversationRow | null> {
    return this.d1.prepare(SQL.setConversationAi).bind(id, enabled ? 1 : 0).first<SocialConversationRow>();
  }

  /** Hand a claimed message to a human and switch the conversation's AI off, atomically. */
  async handOffSocialMessage(messageId: string, conversationRowId: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare(SQL.transitionSocialMessage).bind(messageId, 'claimed', 'needs_human', null, null),
      this.d1.prepare(SQL.handOffConversation).bind(conversationRowId),
    ]);
  }

  /**
   * Claim a customer message (platform time `messageTime`, epoch ms), inserting its row in `status`
   * ("claimed", or "needs_human" when the conversation's AI is off), and supersede the drafts of older
   * messages in the same batch. Returns the new row id, or null when it was already claimed.
   */
  async claimSocialMessage(
    conversationRowId: string,
    externalMessageId: string,
    customerText: string,
    messageTime: number,
    status: 'claimed' | 'needs_human' = 'claimed',
  ): Promise<string | null> {
    const id = newId();
    const [result] = await this.d1.batch([
      this.d1.prepare(SQL.claimSocialMessage).bind(id, conversationRowId, externalMessageId, customerText, status, messageTime),
      this.d1.prepare(SQL.supersedeOlderDrafts).bind(conversationRowId, id),
    ]);
    return (result?.meta?.changes ?? 0) === 1 ? id : null;
  }

  /**
   * Store a claimed message's reply as a draft (or as superseded when a newer message already exists)
   * and supersede the drafts of older messages, atomically. Together with the claim-time supersession
   * this holds whatever order overlapping polls claim and finish in.
   */
  async storeSocialDraft(messageId: string, conversationRowId: string, reply: string): Promise<void> {
    await this.d1.batch([
      this.d1.prepare(SQL.storeSocialDraft).bind(messageId, reply),
      this.d1.prepare(SQL.supersedeOlderDrafts).bind(conversationRowId, messageId),
    ]);
  }

  /** Whether a newer customer message than `id` exists in its conversation. */
  async hasNewerSocialMessage(id: string): Promise<boolean> {
    const row = await this.d1.prepare(SQL.hasNewerSocialMessage).bind(id).first<{ newer: number }>();
    return !!row?.newer;
  }

  /**
   * Rows a dead poll or admin send left behind: `claimed` → failed, `sending` → unknown, once older
   * than `staleSeconds`. Returns how many rows moved.
   */
  async recoverStaleSocialMessages(staleSeconds: number, unknownError: string): Promise<number> {
    const age = `-${Math.max(0, Math.floor(staleSeconds))} seconds`;
    const counts = await this.d1.batch([
      this.d1.prepare(SQL.recoverStaleClaimed).bind(age),
      this.d1.prepare(SQL.recoverStaleSending).bind(age, unknownError),
    ]);
    return counts.reduce((n, r) => n + (r.meta?.changes ?? 0), 0);
  }

  /** Compare-and-set status change. Returns false when the message was not in `from`. */
  async transitionSocialMessage(
    id: string,
    from: SocialMessageStatus,
    to: SocialMessageStatus,
    replyText: string | null = null,
    error: string | null = null,
  ): Promise<boolean> {
    const result = await this.d1
      .prepare(SQL.transitionSocialMessage)
      .bind(id, from, to, replyText, error === null ? null : error.slice(0, 500))
      .run();
    return (result.meta?.changes ?? 0) === 1;
  }

  async claimSocialMessageForAdmin(id: string, text: string | null, confirmUnknown = false): Promise<SocialMessageRow | null> {
    return this.d1
      .prepare(SQL.claimSocialMessageForAdmin)
      .bind(id, text, confirmUnknown ? 1 : 0)
      .first<SocialMessageRow>();
  }

  async getSocialMessage(id: string): Promise<SocialMessageRow | null> {
    return this.d1.prepare(SQL.getSocialMessage).bind(id).first<SocialMessageRow>();
  }

  /** Messages of a conversation, oldest first (the newest `limit`). */
  async listSocialMessages(conversationRowId: string, limit: number): Promise<SocialMessageRow[]> {
    const { results } = await this.d1
      .prepare(SQL.listSocialMessages)
      .bind(conversationRowId, limit)
      .all<SocialMessageRow & { seq?: number }>();
    return results.map(({ seq: _seq, ...row }) => row);
  }
}

/** Random 32-hex id (UUID without dashes). */
export function newId(): string {
  return crypto.randomUUID().replace(/-/g, '');
}
