-- DocFlare AI - direct knowledge docs, admin-editable settings and social livechat
-- Apply with: bun run db:migrate (remote) / bun run db:migrate:local

-- Knowledge entered directly in the admin UI (price lists, FAQ, policies) instead of crawled from a sitemap.
-- Vectors use the pseudo page id "kb-<id>", so vector ids are "kb-<id>-<chunk>".
CREATE TABLE IF NOT EXISTS knowledge_docs (
  id          TEXT PRIMARY KEY,                       -- 32 hex chars (random UUID without dashes)
  site_id     TEXT NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  content     TEXT NOT NULL,
  category    TEXT NOT NULL DEFAULT 'general',        -- pricing | faq | policy | general
  chunk_count INTEGER NOT NULL DEFAULT 0,             -- vector ids 0..chunk_count-1 that may exist for this doc
  deleting    INTEGER NOT NULL DEFAULT 0,             -- 1 once a delete started: saves in flight discard their vectors
  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_knowledge_site ON knowledge_docs (site_id, updated_at);

-- Settings edited from the admin UI. A row overrides the matching environment variable.
-- Values are JSON; secret values are AES-GCM encrypted strings ("v1:<iv>:<ciphertext>").
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,
  value       TEXT NOT NULL,
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Social inbox conversations seen through the remote MCP server.
CREATE TABLE IF NOT EXISTS social_conversations (
  id               TEXT PRIMARY KEY,
  account_id       TEXT NOT NULL,
  conversation_id  TEXT NOT NULL,
  platform         TEXT,
  participant_name TEXT,
  ai_enabled       INTEGER NOT NULL DEFAULT 1,
  status           TEXT NOT NULL DEFAULT 'open',      -- open | needs_human
  last_message_at  TEXT,                              -- inbox updatedTime when last processed (unchanged = skipped)
  updated_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (account_id, conversation_id)
);

-- One row per customer message the agent handled. The UNIQUE constraint is the idempotency key:
-- a message is claimed by inserting its row, so it is answered at most once even when polls overlap.
-- Messages of a conversation are ordered by (message_time, rowid), never by when a poll claimed them:
-- a draft is only sendable while no newer message of its conversation exists (else it is superseded).
CREATE TABLE IF NOT EXISTS social_messages (
  id                  TEXT PRIMARY KEY,
  conversation_row_id TEXT NOT NULL REFERENCES social_conversations(id) ON DELETE CASCADE,
  external_message_id TEXT NOT NULL,
  message_time        INTEGER,                        -- platform time of the customer message (epoch ms); orders messages
  customer_text       TEXT,
  reply_text          TEXT,
  status              TEXT NOT NULL,                  -- claimed | draft | superseded | sending | sent | failed | unknown | needs_human
  error               TEXT,
  created_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at          DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (conversation_row_id, external_message_id)
);

CREATE INDEX IF NOT EXISTS idx_social_messages_conv ON social_messages (conversation_row_id, message_time);
CREATE INDEX IF NOT EXISTS idx_social_conversations_updated ON social_conversations (status, updated_at);
