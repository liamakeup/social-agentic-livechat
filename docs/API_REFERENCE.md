# Social Agentic AI Livechat API Reference

Base URL: `https://docflare-ai.<your-subdomain>.workers.dev` (or your custom domain).

All request and response bodies are JSON unless stated otherwise. Timestamps are UTC ISO-8601.

## Authentication

| Route group                           | Requirement                                                                                                                                                                                                                                                     |
|---------------------------------------|-----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `/api/sites/*`, `/api/settings`, `/api/mcp/*`, `/api/social/*` | `Authorization: Bearer <ADMIN_TOKEN>` (the secret set with `wrangler secret put ADMIN_TOKEN`)                                                                                                                                                                   |
| `/api/chat`                           | No token. The request `Origin` must match the site's registered domain or an entry in `ALLOWED_ORIGINS`. Requests without an `Origin` header are accepted. Rate-limited per site and client IP (`CHAT_RATE_LIMITER`) and per site per day (`DAILY_CHAT_LIMIT`). |
| `/api/health`, `/widget.js`, `/admin` | None (the admin page asks for the token in the browser and sends it as a bearer header)                                                                                                                                                                         |

## Errors

Errors always have this shape:

```json
{ "error": "human readable message", "code": "machine_readable_code" }
```

| Status | Code                                                                                   | When                                                                                                     |
|--------|----------------------------------------------------------------------------------------|----------------------------------------------------------------------------------------------------------|
| 400    | `invalid_json`, `invalid_site_id`, `invalid_url`, `invalid_question`, `invalid_domain` | Malformed input                                                                                          |
| 401    | `unauthorized`                                                                         | Missing/invalid admin token                                                                              |
| 403    | `origin_not_allowed`                                                                   | `Origin` does not match the site's domain                                                                |
| 404    | `site_not_found`, `not_found`                                                          | Unknown site / route                                                                                     |
| 422    | `crawl_error`                                                                          | Sitemap unreachable, empty, or no same-domain HTML URLs                                                  |
| 429    | `ai_rate_limited`                                                                      | Workers AI quota or rate limit hit (`Retry-After: 60`)                                                   |
| 429    | `rate_limited`                                                                         | Too many questions from this client for this site in the last minute (`Retry-After: 60`)                 |
| 429    | `daily_limit_reached`                                                                  | The site answered `DAILY_CHAT_LIMIT` questions in the last 24 hours (`Retry-After: 60`)                  |
| 409    | `message_not_sendable`, `social_off`, `mcp_not_configured`                             | Social livechat action not possible in the current state                                                 |
| 502    | `ai_error`                                                                             | Workers AI (and the fallback LLM, if configured) failed; details only in Worker logs                     |
| 503    | `admin_token_missing`                                                                  | `ADMIN_TOKEN` secret not configured                                                                      |
| 503    | `admin_token_weak`                                                                     | `ADMIN_TOKEN` is the `.dev.vars.example` value or shorter than 16 characters (allowed on localhost only) |
| 500    | `internal_error`                                                                       | Unexpected failure (details in Worker logs)                                                              |

`siteId` values are case-insensitive and normalised to lowercase. Pattern: `^[a-z0-9][a-z0-9_-]{0,63}$`.

---

## `GET /api/health`

Liveness probe. Public and cheap: it reads nothing from D1 and says nothing about the fallback LLM or the social integration (admins see those in `GET /api/settings`).

```json
{
  "ok": true,
  "service": "social-agentic-livechat",
  "models": { "embedding": "@cf/baai/bge-m3", "chat": "@cf/meta/llama-3.1-8b-instruct-fp8" },
  "time": "2026-10-07T09:00:00.000Z"
}
```

---

## `GET /api/sites`

All registered sites with their indexing progress. Powers the admin UI. `processing` counts pages claimed by a running cron tick or `/process` call; a claim that is not finished within 15 minutes (the invocation died) is handed out again, and a page that is claimed more than 3 times this way is marked `failed`.

```json
{
  "sites": [
    {
      "id": "my-docs",
      "domain": "docs.example.com",
      "sitemap_url": "https://docs.example.com/sitemap.xml",
      "created_at": "2026-10-07 09:00:00",
      "progress": { "siteId": "my-docs", "total": 142, "pending": 94, "processing": 3, "indexed": 44, "failed": 1 }
    }
  ]
}
```

---

## `POST /api/sites/index`

Register (or refresh) a site and queue every HTML URL found in its sitemap. Existing pages are reset to `pending`, so calling this again re-crawls the whole site. Pages no longer in the sitemap (or past `MAX_PAGES`) are deleted together with their vectors and counted in `removed`.

**Request**

```json
{
  "siteId": "my-docs",
  "sitemapUrl": "https://docs.example.com/sitemap.xml",
  "domain": "docs.example.com",
  "process": false
}
```

| Field        | Type    | Required | Notes                                                                                                                                                                                                               |
|--------------|---------|----------|---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------|
| `siteId`     | string  | yes      | Slug, 1-64 chars                                                                                                                                                                                                    |
| `sitemapUrl` | string  | yes      | Absolute `http(s)` URL of a sitemap or sitemap index (`.xml` or `.xml.gz`)                                                                                                                                          |
| `domain`     | string  | no       | Hostname allowed to embed the widget and crawl scope: `docs.example.com`, or `*.example.com` for the apex and every subdomain. Defaults to the domain already registered for `siteId`, else the sitemap's hostname. |
| `process`    | boolean | no       | When `true`, also crawl one batch of pages inline before responding.                                                                                                                                                |

**Response `202 Accepted`**

```json
{
  "siteId": "my-docs",
  "domain": "docs.example.com",
  "sitemapUrl": "https://docs.example.com/sitemap.xml",
  "queued": 142,
  "removed": 0,
  "progress": { "siteId": "my-docs", "total": 142, "pending": 142, "processing": 0, "indexed": 0, "failed": 0 },
  "processed": null,
  "next": "Pending pages are crawled 3 at a time by the cron trigger. Call POST /api/sites/my-docs/process repeatedly to finish faster."
}
```

`processed` contains a [process result](#post-apisitessiteidprocess) when `process: true` was sent.

**Example**

```bash
curl -X POST "$WORKER_URL/api/sites/index" \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"siteId":"my-docs","sitemapUrl":"https://docs.example.com/sitemap.xml"}'
```

---

## `POST /api/sites/:siteId/process`

Claim, crawl, chunk, embed and store the next `INDEX_BATCH_SIZE` pending pages for the site. Call repeatedly until `progress.pending` and `progress.processing` are `0`. The cron trigger performs the same work automatically once a minute; claims are atomic, so concurrent calls never index the same page twice. `processed: 0` with pages left means the remaining pages are claimed by another invocation.

**Response `200 OK`** (or `429` with the same body when Workers AI rate-limited the batch; unprocessed pages go back to the queue)

```json
{
  "processed": 3,
  "indexed": 2,
  "failed": 1,
  "rateLimited": false,
  "results": [
    { "url": "https://docs.example.com/intro", "status": "indexed", "title": "Introduction", "chunks": 4 },
    { "url": "https://docs.example.com/install", "status": "indexed", "title": "Installation", "chunks": 7 },
    { "url": "https://docs.example.com/old", "status": "failed", "error": "Failed to fetch https://docs.example.com/old: HTTP 404" }
  ],
  "progress": { "siteId": "my-docs", "total": 142, "pending": 139, "processing": 0, "indexed": 2, "failed": 1 }
}
```

---

## `GET /api/sites/:siteId/status`

```json
{
  "site": {
    "id": "my-docs",
    "domain": "docs.example.com",
    "sitemap_url": "https://docs.example.com/sitemap.xml",
    "created_at": "2026-10-07 09:00:00"
  },
  "progress": { "siteId": "my-docs", "total": 142, "pending": 0, "processing": 0, "indexed": 140, "failed": 2 }
}
```

---

## `GET /api/sites/:siteId/queries`

Recent chat log for a site, newest first. Query parameter `limit` (1-100, default 20).

```json
{
  "siteId": "my-docs",
  "queries": [
    {
      "id": "6f1c0e6e-5a4b-4f3b-9d1e-2c7a0b9f8e11",
      "site_id": "my-docs",
      "prompt": "How do I deploy to production?",
      "response": "Run `bun run deploy` …",
      "created_at": "2026-10-07 09:40:12"
    }
  ]
}
```

---

## `DELETE /api/sites/:siteId`

Removes the site row, its pages, its knowledge docs, its chat history and their vectors.

```json
{ "siteId": "my-docs", "deleted": true, "vectorsDeleted": 611 }
```

---

## `POST /api/chat`

Answer a question using the site's indexed content.

**Request**

```json
{
  "siteId": "my-docs",
  "question": "How do I deploy to production?",
  "stream": true,
  "history": [
    { "role": "user", "content": "What is DocFlare?" },
    { "role": "assistant", "content": "DocFlare is …" }
  ]
}
```

| Field      | Type    | Required | Notes                                                            |
|------------|---------|----------|------------------------------------------------------------------|
| `siteId`   | string  | yes      | Registered site                                                  |
| `question` | string  | yes      | 1-1000 characters                                                |
| `stream`   | boolean | no       | `true` → Server-Sent Events; default JSON                        |
| `history`  | array   | no       | Up to 10 previous turns, oldest first. Only the last 6 are used. |

### JSON response (`stream` omitted or `false`)

```json
{
  "id": "6f1c0e6e-5a4b-4f3b-9d1e-2c7a0b9f8e11",
  "answer": "Run `bun run deploy`. Wrangler prints the Worker URL when it finishes.",
  "sources": [
    { "index": 1, "url": "https://docs.example.com/deploy", "title": "Deploying", "score": 0.8412 },
    { "index": 2, "url": "https://docs.example.com/cli", "title": "CLI reference", "score": 0.7731 }
  ]
}
```

`sources` are ordered by relevance (`index` is 1-based). `score` is the reranker's relevance score (0-1, sigmoid) when `RERANK` is on, otherwise the cosine similarity from Vectorize. The answer contains no citation markers; render `sources` as links. Several sources may point at the same URL (different chunks of one page). Answers are written in the language of the question.

### SSE response (`stream: true`)

`Content-Type: text/event-stream`. Events arrive in this order:

```
event: meta
data: {"id":"6f1c…","sources":[{"index":1,"url":"https://docs.example.com/deploy","title":"Deploying","score":0.8412}]}

event: token
data: {"text":"Run "}

event: token
data: {"text":"`bun run deploy`."}

event: done
data: {"id":"6f1c…"}
```

| Event   | Payload             | Notes                                                    |
|---------|---------------------|----------------------------------------------------------|
| `meta`  | `{ id, sources[] }` | Always first. `sources` may be empty.                    |
| `token` | `{ text }`          | Zero or more; concatenate in order.                      |
| `done`  | `{ id }`            | Stream finished normally.                                |
| `error` | `{ message }`       | Emitted instead of `done` if generation was interrupted. |

HTTP-level failures (400/403/404/429/502) are returned as normal JSON error responses before any event is sent. The `error` event carries a generic message; the cause is in the Worker logs (`chat.stream_failed`).

**Minimal client**

```js
const res = await fetch(`${WORKER_URL}/api/chat`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ siteId: 'my-docs', question: 'How do I deploy?', stream: true }),
});
const reader = res.body.getReader();
const decoder = new TextDecoder();
let buffer = '';
for (;;) {
  const { done, value } = await reader.read();
  if (done) break;
  buffer += decoder.decode(value, { stream: true });
  const events = buffer.split('\n\n');
  buffer = events.pop();
  for (const raw of events) {
    const type = /^event: (.*)$/m.exec(raw)?.[1];
    const data = JSON.parse(/^data: (.*)$/m.exec(raw)?.[1] ?? '{}');
    if (type === 'token') process.stdout.write(data.text);
  }
}
```

---

## Direct knowledge docs (admin)

Price lists, FAQ and policies typed in the admin UI instead of crawled. Each doc is chunked and embedded into the site's namespace with vector ids `kb-<docId>-<n>`; its sources have `url: "kb:<docId>"`, which the widget shows as plain text (no link). Requires migration `0002_social_livechat.sql`.

| Method & path | Body | Response |
|---|---|---|
| `GET /api/sites/:siteId/knowledge` | | `{ docs: [{ id, title, category, chunkCount, contentLength, createdAt, updatedAt }] }` |
| `GET /api/sites/:siteId/knowledge/:docId` | | `{ doc: { …, content } }` |
| `POST /api/sites/:siteId/knowledge` | `{ id?, title, content, category? }` | `201` (create) / `200` (update, `id` given) `{ doc, chunksIndexed }` |
| `DELETE /api/sites/:siteId/knowledge/:docId` | | `{ deleted: true, vectorsDeleted }` |
| `POST /api/sites/:siteId/knowledge/:docId/reindex` | | `{ doc, chunksIndexed }` |
| `POST /api/sites/:siteId/test-chat` | `{ question, history? }` | Same as `POST /api/chat` JSON (`{ id, answer, sources }`); no origin check, no daily limit, not logged |

`title` 1–200 characters, `content` 1–50 000 characters, `category` one of `pricing`, `faq`, `policy`, `general` (default). Errors: `400 invalid_knowledge` / `invalid_doc_id`, `404 knowledge_not_found`. An update re-chunks the doc and deletes vectors left over from a longer previous version. A create, update or reindex whose doc is deleted while it is being indexed removes the vectors it wrote and answers `404 knowledge_not_found`. Deleting a site also deletes its knowledge docs and their vectors.

---

## `GET /api/settings` / `POST /api/settings` (admin)

Settings editable from the admin UI, stored in D1 (`app_settings`). Environment variables are the defaults; a saved value overrides them.

```json
{
  "prompt": { "systemPrompt": "" },
  "fallback": { "strategy": "cf-first", "baseUrl": "", "model": "", "apiKeySet": false, "apiKeyUndecryptable": false },
  "mcp": { "url": "", "tokenSet": false, "tokenUndecryptable": false, "proxyTool": "", "socialSiteId": "", "socialMode": "off",
           "pollIntervalMinutes": 2, "maxRepliesPerTick": 3, "accountId": "",
           "toolListConversations": "messages_list_inbox_conversations",
           "toolListMessages": "messages_get_inbox_conversation_messages",
           "toolSendMessage": "messages_send_inbox_message", "socialEnabledAt": null }
}
```

`POST` takes any subset of the same groups plus the write-only secrets `fallback.apiKey` and `mcp.token`, and returns the shape above. Secrets are AES-GCM encrypted at rest (key derived from `SETTINGS_KEY`, else `ADMIN_TOKEN`) and never returned. For a secret, an omitted field or `""` keeps the stored value, `null` clears it (also hiding an env-var value), any other string replaces it. If a stored secret no longer decrypts (`SETTINGS_KEY`, or without it `ADMIN_TOKEN`, was rotated) it is treated as unset and `apiKeyUndecryptable` / `tokenUndecryptable` is `true` until the secret is saved again; the admin page shows a warning. Changing the host (host and port) of `mcp.url`, including clearing the URL, without supplying `mcp.token` in the same request clears the stored MCP token, so a token is never sent to a server it was not entered for (host A → `""` → host B ends without a token); a new path on the same host keeps it.

Validation (`400 invalid_settings`): `systemPrompt` ≤ 4000 characters (when set it replaces the "You are DocFlare…" line of the prompt; the grounding rules stay); `strategy` ∈ `cf-first | external-first | cf-only | external-only`; `baseUrl` / `mcp.url` https (http only for localhost) or `""` to clear; `socialMode` ∈ `off | draft | auto`; `pollIntervalMinutes` integer 1–60; `maxRepliesPerTick` integer 1–10; tool names `[A-Za-z0-9_.:/-]`; when `socialMode` is not `off`, `mcp.url` must be set and `socialSiteId` must be a registered site. Switching `socialMode` from `off` to `draft`/`auto` records `socialEnabledAt`: customer messages older than that are never answered.

The fallback LLM is used only when `baseUrl`, `model` and the API key are all set; otherwise every strategy behaves as Workers AI only.

---

## `POST /api/mcp/test-connection` (admin)

Runs the MCP handshake and `tools/list` with the saved settings. Always HTTP 200.

```json
{ "ok": true, "serverName": "zernio", "tools": ["search_tools", "call_tool"] }
```
or `{ "ok": false, "error": "MCP HTTP 401" }` (never contains the token).

---

## Social livechat (admin)

The agent polls the inbox through the remote MCP server (from the cron trigger every `pollIntervalMinutes` while `socialMode` is not `off`, or on demand), answers new customer messages with the RAG pipeline of `socialSiteId`, and in `auto` mode sends the reply, in `draft` mode stores it for review. A customer asking for a person ("nhân viên", "người thật", "tư vấn viên", "human", "agent", "staff"), or a question with no relevant knowledge, hands the conversation off (`needs_human`, AI switched off for it) without replying. Each customer message is answered at most once; a send is never retried automatically. A conversation whose AI is off is not answered, but a new customer message in it is recorded as `needs_human` so it shows on the dashboard.

Each poll first recovers rows left behind by an invocation that died: `claimed` for more than 5 minutes becomes `failed` (`"interrupted before send"`; nothing was sent), `sending` for more than 5 minutes becomes `unknown`. A conversation whose inbox `updatedTime` equals the one recorded when it was last processed is skipped without any MCP call; only conversations whose latest message is claimed for an AI answer count toward `maxRepliesPerTick`.

Subrequest budget: the poll keeps to 40 of the Workers Free plan's 50 subrequests per invocation (the cron invocation also runs the crawler batch, which shares the same 50). It reserves 4 for the handshake and conversation list, and each AI-answered conversation costs up to 8 (messages fetch, embedding, vector query, rerank, generation, possible fallback, send), so at most 4 replies are sent per tick whatever `maxRepliesPerTick` says. The effective cap is returned as `replyCap` and logged (`social.poll`).

| Method & path | Body | Response |
|---|---|---|
| `GET /api/social/conversations?status=open\|needs_human\|all&limit=50` | | `{ conversations: [{ id, accountId, conversationId, platform, participantName, aiEnabled, status, lastMessageAt, updatedAt, lastCustomerText, lastReplyText, lastReplyStatus }] }` |
| `GET /api/social/conversations/:id/messages` | | `{ messages: [{ id, externalMessageId, customerText, replyText, status, error, createdAt, updatedAt }] }` (oldest first, max 100) |
| `POST /api/social/conversations/:id/ai` | `{ enabled: boolean }` | Conversation object; enabling also sets `status: "open"` |
| `POST /api/social/messages/:id/send` | `{ text?, confirmUnknown? }` (`text` ≤ 2000, `confirmUnknown` boolean) | Message object (`status` `sent`; `failed` or `unknown` with `error`) |
| `POST /api/social/poll` | | `{ checked, replied, drafted, handedOff, needsHuman, skipped, replyCap, recovered, errors: [] }` |

Message `status`:

| Status | Meaning | Admin `send` |
|---|---|---|
| `claimed` | Being answered by a poll | no |
| `draft` | Reply generated in `draft` mode, waiting for review | yes |
| `superseded` | An outdated draft: a newer customer message exists in the same conversation (ordered by the platform message time, whatever order the polls finished in; shown greyed) | no |
| `sending` | Send in progress | no |
| `sent` | Delivered | no |
| `failed` | Definitely not delivered: the platform rejected it (HTTP 4xx, JSON-RPC error, tool error), it was never sent, or the poll was interrupted before sending | yes |
| `unknown` | The send may have reached the customer (timeout, network error, HTTP 5xx, interrupted while sending). `error` starts with "send outcome unknown; check the platform before resending" | only with `confirmUnknown: true` |
| `needs_human` | Handed off, or a new message in a conversation whose AI is off | yes (needs `text`) |

`send` claims the message atomically: a second (or concurrent) call, a message in a non-sendable status, or a `draft` whose conversation has a newer customer message answers `409 message_not_sendable`; an `unknown` message without `confirmUnknown: true` answers `409 confirm_required`; a message without reply text needs `text` (`400 text_required`). If recording the outcome in D1 fails after a successful send, the message stays `sending` and the next poll after 5 minutes marks it `unknown`.

`poll` answers `409 social_off` while `socialMode` is `off`, and `409 mcp_not_configured` / `site_not_found` when the MCP URL or social site is missing. It runs under `waitUntil`, so closing the admin tab does not cancel it midway; the response still carries the summary. `checked` counts candidate conversations looked at (including those skipped without an MCP call); `needsHuman` counts messages recorded in AI-off conversations; `recovered` counts stale rows fixed at the start.

---

## `GET /widget.js`

The embeddable widget (minified, ~9 KB, `Cache-Control: public, max-age=3600`). Configuration is passed through `data-*` attributes on the script tag; see the README for the full list.

```html
<script src="https://docflare-ai.<your-subdomain>.workers.dev/widget.js" data-site-id="my-docs" defer></script>
```

---

## `GET /admin`

Static admin page (`public/admin.html`). Enter the `ADMIN_TOKEN`; it is kept in `sessionStorage` for the tab and sent as `Authorization: Bearer` on every call. Supports `?theme=dark|light`.

![Admin UI](images/admin.png)

---

## OpenAPI 3.1

```yaml
openapi: 3.1.0
info:
  title: DocFlare AI
  version: 0.1.0
  description: Zero-cost AI site search & chatbot running on Cloudflare Workers, Workers AI, Vectorize and D1.
  license: { name: MIT }
servers:
  - url: https://docflare-ai.{subdomain}.workers.dev
    variables: { subdomain: { default: your-subdomain } }
components:
  securitySchemes:
    adminToken: { type: http, scheme: bearer }
  schemas:
    Error:
      type: object
      required: [error, code]
      properties: { error: { type: string }, code: { type: string } }
    Progress:
      type: object
      required: [siteId, total, pending, processing, indexed, failed]
      properties:
        siteId: { type: string }
        total: { type: integer }
        pending: { type: integer }
        processing: { type: integer }
        indexed: { type: integer }
        failed: { type: integer }
    PageResult:
      type: object
      required: [url, status]
      properties:
        url: { type: string, format: uri }
        status: { type: string, enum: [indexed, failed] }
        title: { type: string }
        chunks: { type: integer }
        error: { type: string }
    ProcessResult:
      type: object
      required: [processed, indexed, failed, rateLimited, results, progress]
      properties:
        processed: { type: integer }
        indexed: { type: integer }
        failed: { type: integer }
        rateLimited: { type: boolean }
        results: { type: array, items: { $ref: '#/components/schemas/PageResult' } }
        progress: { $ref: '#/components/schemas/Progress' }
    Source:
      type: object
      required: [index, url, title, score]
      properties:
        index: { type: integer, minimum: 1 }
        url: { type: string, format: uri }
        title: { type: string }
        score: { type: number }
    ChatMessage:
      type: object
      required: [role, content]
      properties:
        role: { type: string, enum: [user, assistant] }
        content: { type: string }
    ChatRequest:
      type: object
      required: [siteId, question]
      properties:
        siteId: { type: string, pattern: '^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$' }
        question: { type: string, minLength: 1, maxLength: 1000 }
        stream: { type: boolean, default: false }
        history: { type: array, maxItems: 10, items: { $ref: '#/components/schemas/ChatMessage' } }
    ChatResponse:
      type: object
      required: [id, answer, sources]
      properties:
        id: { type: string, format: uuid }
        answer: { type: string }
        sources: { type: array, items: { $ref: '#/components/schemas/Source' } }
paths:
  /api/health:
    get:
      summary: Liveness probe
      responses:
        '200': { description: OK }
  /api/sites:
    get:
      summary: List sites with indexing progress
      security: [{ adminToken: [] }]
      responses:
        '200': { description: Sites }
  /api/sites/index:
    post:
      summary: Register a site and queue its sitemap URLs
      security: [{ adminToken: [] }]
      requestBody:
        required: true
        content:
          application/json:
            schema:
              type: object
              required: [siteId, sitemapUrl]
              properties:
                siteId: { type: string }
                sitemapUrl: { type: string, format: uri }
                domain: { type: string, description: 'Hostname or *.wildcard; defaults to the registered domain, then the sitemap host' }
                process: { type: boolean, default: false }
      responses:
        '202': { description: Site registered, pages queued }
        '400': { description: Invalid input, content: { application/json: { schema: { $ref: '#/components/schemas/Error' } } } }
        '401': { description: Unauthorized }
        '422': { description: Sitemap error }
  /api/sites/{siteId}/process:
    post:
      summary: Crawl and embed the next batch of pending pages
      security: [{ adminToken: [] }]
      parameters: [{ name: siteId, in: path, required: true, schema: { type: string } }]
      responses:
        '200': { description: Batch processed, content: { application/json: { schema: { $ref: '#/components/schemas/ProcessResult' } } } }
        '429': { description: Workers AI rate limited; unprocessed pages go back to the queue, content: { application/json: { schema: { $ref: '#/components/schemas/ProcessResult' } } } }
  /api/sites/{siteId}/status:
    get:
      summary: Indexing progress
      security: [{ adminToken: [] }]
      parameters: [{ name: siteId, in: path, required: true, schema: { type: string } }]
      responses:
        '200': { description: Site and progress }
        '404': { description: Unknown site }
  /api/sites/{siteId}/queries:
    get:
      summary: Recent questions and answers for a site
      security: [{ adminToken: [] }]
      parameters:
        - { name: siteId, in: path, required: true, schema: { type: string } }
        - { name: limit, in: query, required: false, schema: { type: integer, minimum: 1, maximum: 100, default: 20 } }
      responses:
        '200': { description: Query log, newest first }
        '404': { description: Unknown site }
  /api/sites/{siteId}:
    delete:
      summary: Delete a site, its pages, chat log and vectors
      security: [{ adminToken: [] }]
      parameters: [{ name: siteId, in: path, required: true, schema: { type: string } }]
      responses:
        '200': { description: Deleted }
  /api/chat:
    post:
      summary: Ask a question about a site's documentation
      requestBody:
        required: true
        content:
          application/json:
            schema: { $ref: '#/components/schemas/ChatRequest' }
      responses:
        '200':
          description: Answer (JSON) or event stream when stream=true
          content:
            application/json: { schema: { $ref: '#/components/schemas/ChatResponse' } }
            text/event-stream: { schema: { type: string } }
        '403': { description: Origin not allowed for this site }
        '404': { description: Unknown site }
        '429': { description: 'Rate limited: rate_limited (per client), daily_limit_reached (per site) or ai_rate_limited (Workers AI quota)' }
        '502': { description: Workers AI error }
  /widget.js:
    get:
      summary: Embeddable widget script
      responses:
        '200': { description: JavaScript, content: { application/javascript: { schema: { type: string } } } }
```
