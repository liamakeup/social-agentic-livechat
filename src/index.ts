/**
 * Social Agentic AI Livechat - Hono application entrypoint.
 *
 * Routes:
 *   GET    /api/health                   liveness + model info
 *   GET    /api/sites                    list sites with indexing progress            (admin)
 *   POST   /api/sites/index              register a site + queue its sitemap URLs   (admin)
 *   POST   /api/sites/:siteId/process    crawl + embed the next batch of pages      (admin)
 *   GET    /api/sites/:siteId/status     indexing progress                           (admin)
 *   GET    /api/sites/:siteId/queries    recent chat log                             (admin)
 *   DELETE /api/sites/:siteId            remove a site and its vectors               (admin)
 *   *      /api/sites/:siteId/knowledge  direct knowledge docs (see routes/knowledge.ts) (admin)
 *   POST   /api/sites/:siteId/test-chat  RAG answer for the admin UI                 (admin)
 *   GET/POST /api/settings, /api/mcp/*, /api/social/*  (see routes/social.ts)         (admin)
 *   POST   /api/chat                     RAG answer (JSON or SSE stream)             (public, origin-checked, rate-limited)
 *   GET    /widget.js                    embeddable widget (also served as a static asset)
 *   GET    /admin                        admin UI (static asset public/admin.html)
 */
import { Hono } from 'hono';
import { intVar, loadConfig } from './config';
import { Db, emptyProgress } from './db/schema';
import { readJson, requireAdmin, requireHttpUrl, requireQuestion, requireSite, requireSiteId, sanitizeHistory } from './http';
import { registerKnowledgeRoutes } from './routes/knowledge';
import { socialAdminRoutes } from './routes/social';
import {
  AiRateLimitError,
  CHAT_MODEL,
  EMBEDDING_MODEL,
  ExternalAiError,
  RERANK_MODEL,
  buildRagMessages,
  generateHybridAnswer,
  generateHybridAnswerStream,
  textToWorkersAiStream,
} from './services/ai';
import { CrawlError } from './services/crawler';
import { getProgress, processPendingPages, registerSite, removeSite } from './services/indexer';
import { NO_CONTEXT_ANSWER, retrieve } from './services/rag';
import { loadSettings } from './services/settings';
import { pollSocialInbox } from './services/social-agent';
import { buildChatStream } from './services/stream';
import { cors, isOriginAllowed, normalizeDomain } from './utils/cors';
import { HttpError, type AppBindings, type ChatRequest, type ChatResponse, type Env, type IndexSiteRequest } from './types';

/** Window for DAILY_CHAT_LIMIT. */
const CHAT_LIMIT_WINDOW_HOURS = 24;
const AI_ERROR_MESSAGE = 'The AI model is unavailable right now. Please try again later.';

/** The site domain from the request body, or null when it was not given. */
function optionalDomain(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  const domain = normalizeDomain(value);
  if (!domain) {
    throw new HttpError(400, 'domain must be a hostname such as "docs.example.com" or "*.example.com"', 'invalid_domain');
  }
  return domain;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------

const app = new Hono<AppBindings>();

app.use('*', cors());

app.onError((err, c) => {
  if (err instanceof HttpError) {
    if (err.status === 429) c.header('Retry-After', '60');
    return c.json({ error: err.message, code: err.code }, err.status as 400);
  }
  if (err instanceof AiRateLimitError) {
    c.header('Retry-After', '60');
    return c.json({ error: err.message, code: 'ai_rate_limited' }, 429);
  }
  if (err instanceof CrawlError) {
    return c.json({ error: err.message, code: 'crawl_error' }, 422);
  }
  if (err.name === 'AiError' || err instanceof ExternalAiError) {
    // Workers AI failures (model deprecated, unavailable, bad input): a 502 instead of a bare 500. The
    // details go to the logs only; /api/chat is public.
    console.error(JSON.stringify({ event: 'ai_error', message: err.message }));
    return c.json({ error: AI_ERROR_MESSAGE, code: 'ai_error' }, 502);
  }
  console.error(JSON.stringify({ event: 'unhandled_error', message: err.message, stack: err.stack }));
  return c.json({ error: 'Internal server error', code: 'internal_error' }, 500);
});

app.notFound((c) => c.json({ error: 'Not found', code: 'not_found' }, 404));

/** Public and cheap: no D1 read, nothing about the fallback provider or the social integration. */
app.get('/api/health', (c) =>
  c.json({
    ok: true,
    service: 'social-agentic-livechat',
    models: { embedding: EMBEDDING_MODEL, chat: CHAT_MODEL, rerank: loadConfig(c.env).rerank ? RERANK_MODEL : null },
    time: new Date().toISOString(),
  }),
);

/**
 * Widget script. In production the static-assets layer usually serves this before the Worker
 * runs; this route is the fallback (e.g. custom routing) and adds explicit caching/CORS headers.
 */
app.get('/widget.js', async (c) => {
  const asset = await c.env.ASSETS.fetch(new Request(new URL('/widget.js', c.req.url), { method: 'GET' }));
  if (!asset.ok) throw new HttpError(404, 'widget.js not found in assets', 'not_found');
  return new Response(asset.body, {
    status: 200,
    headers: {
      'Content-Type': 'application/javascript; charset=utf-8',
      'Cache-Control': 'public, max-age=3600, stale-while-revalidate=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
});

// --- Management routes -------------------------------------------------------

const sites = new Hono<AppBindings>();
sites.use('*', requireAdmin);

/** All registered sites with their indexing progress (powers the admin UI). */
sites.get('/', async (c) => {
  const db = new Db(c.env.DB);
  const [rows, progress] = await Promise.all([db.listSites(), db.progressAll()]);
  return c.json({
    sites: rows.map((site) => ({
      ...site,
      progress: progress.get(site.id) ?? emptyProgress(site.id),
    })),
  });
});

/** Register a site and queue its sitemap for crawling. */
sites.post('/index', async (c) => {
  const config = loadConfig(c.env);
  const body = await readJson<Partial<IndexSiteRequest>>(c);

  const siteId = requireSiteId(body.siteId);
  const sitemap = requireHttpUrl(body.sitemapUrl, 'sitemapUrl');
  // Without an explicit domain a re-index keeps the registered one (a custom or wildcard domain must
  // survive "Re-crawl sitemap"); a new site defaults to the sitemap host.
  const existing = await new Db(c.env.DB).getSite(siteId);
  const domain = optionalDomain(body.domain) ?? existing?.domain ?? normalizeDomain(sitemap.hostname);
  if (!domain) {
    throw new HttpError(400, 'The sitemap host is not a plain hostname; pass "domain" explicitly', 'invalid_domain');
  }

  const registered = await registerSite(c.env, siteId, sitemap.toString(), domain, config.maxPages);

  const inline = body.process === true ? await processPendingPages(c.env, siteId, config.indexBatchSize) : null;
  const progress = await getProgress(c.env, siteId);

  return c.json(
    {
      ...registered,
      progress,
      processed: inline,
      next:
        progress.pending > 0
          ? `Pending pages are crawled ${config.indexBatchSize} at a time by the cron trigger. ` +
            `Call POST /api/sites/${siteId}/process repeatedly to finish faster.`
          : 'All pages indexed.',
    },
    202,
  );
});

/** Crawl + embed the next batch of pending pages for a site. */
sites.post('/:siteId/process', async (c) => {
  const config = loadConfig(c.env);
  const siteId = requireSiteId(c.req.param('siteId'));
  await requireSite(new Db(c.env.DB), siteId);

  const batch = await processPendingPages(c.env, siteId, config.indexBatchSize);
  const progress = await getProgress(c.env, siteId);
  return c.json({ ...batch, progress }, batch.rateLimited ? 429 : 200);
});

/** Indexing progress for a site. */
sites.get('/:siteId/status', async (c) => {
  const siteId = requireSiteId(c.req.param('siteId'));
  const site = await requireSite(new Db(c.env.DB), siteId);
  const progress = await getProgress(c.env, siteId);
  return c.json({ site, progress });
});

/** Recent questions and answers for a site (newest first). */
sites.get('/:siteId/queries', async (c) => {
  const siteId = requireSiteId(c.req.param('siteId'));
  const db = new Db(c.env.DB);
  await requireSite(db, siteId);
  const limit = intVar(c.req.query('limit'), 20, 1, 100);
  const queries = await db.listQueries(siteId, limit);
  return c.json({ siteId, queries });
});

/** Delete a site, its pages, chat history and vectors. */
sites.delete('/:siteId', async (c) => {
  const siteId = requireSiteId(c.req.param('siteId'));
  await requireSite(new Db(c.env.DB), siteId);
  const result = await removeSite(c.env, siteId);
  return c.json({ siteId, deleted: true, ...result });
});

registerKnowledgeRoutes(sites);

app.route('/api/sites', sites);
app.route('/api', socialAdminRoutes);

// --- Chat --------------------------------------------------------------------

app.post('/api/chat', async (c) => {
  const config = loadConfig(c.env);
  const body = await readJson<Partial<ChatRequest>>(c);

  const siteId = requireSiteId(body.siteId);
  const question = requireQuestion(body.question);
  const history = sanitizeHistory(body.history);
  const wantsStream = body.stream === true;

  // Abuse guard 1: per site + client burst limit. Runs before any D1 read; the Origin check below does
  // not stop non-browser clients, so this is what keeps a script from draining the Workers AI quota.
  if (c.env.CHAT_RATE_LIMITER) {
    const client = c.req.header('CF-Connecting-IP') ?? 'unknown';
    const { success } = await c.env.CHAT_RATE_LIMITER.limit({ key: `${siteId}:${client}` });
    if (!success) throw new HttpError(429, 'Too many questions. Please wait a minute and try again.', 'rate_limited');
  }

  const db = new Db(c.env.DB);
  const site = await requireSite(db, siteId);

  // Only the site's own domain (plus ALLOWED_ORIGINS) may embed the widget.
  const origin = c.req.header('Origin');
  if (!isOriginAllowed(origin, site.domain, config.allowedOrigins)) {
    throw new HttpError(403, `Origin ${origin} is not allowed for site "${siteId}"`, 'origin_not_allowed');
  }

  // Abuse guard 2: per-site daily budget, so one site (or a distributed client) cannot use up the
  // Workers AI quota shared by every site on this deployment.
  if (
    config.dailyChatLimit > 0 &&
    (await db.countQueriesSince(siteId, CHAT_LIMIT_WINDOW_HOURS)) >= config.dailyChatLimit
  ) {
    throw new HttpError(
      429,
      'This documentation assistant reached its daily question limit. Please try again later.',
      'daily_limit_reached',
    );
  }

  const settings = await loadSettings(c.env);
  const { chunks, sources } = await retrieve(c.env, config, siteId, question);
  const id = crypto.randomUUID();
  const persist = (answer: string) => db.logQuery(id, siteId, question, answer);

  // Generation. Skip the LLM entirely when nothing relevant was retrieved (saves quota).
  if (wantsStream) {
    const aiStream =
      chunks.length === 0
        ? textToWorkersAiStream(NO_CONTEXT_ANSWER)
        : await generateHybridAnswerStream(
            c.env.AI,
            buildRagMessages(question, chunks, history, site.domain, settings.prompt.systemPrompt),
            settings.fallback,
          );

    const { stream, finished } = buildChatStream(id, sources, aiStream, persist);
    c.executionCtx.waitUntil(finished);

    return new Response(stream, {
      status: 200,
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no',
      },
    });
  }

  const answer =
    chunks.length === 0
      ? NO_CONTEXT_ANSWER
      : await generateHybridAnswer(
          c.env.AI,
          buildRagMessages(question, chunks, history, site.domain, settings.prompt.systemPrompt),
          settings.fallback,
        );

  c.executionCtx.waitUntil(persist(answer));
  const response: ChatResponse = { id, answer, sources };
  return c.json(response);
});

// ---------------------------------------------------------------------------
// Worker export: HTTP + cron
// ---------------------------------------------------------------------------

export default {
  fetch: app.fetch,

  /**
   * Cron trigger (every minute): crawl the next batch of pending pages across all sites, once an hour
   * delete chat log rows older than QUERY_RETENTION_DAYS, and every mcp.pollIntervalMinutes poll the
   * social inbox when social replies are on.
   */
  async scheduled(controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    const config = loadConfig(env);
    const logFailure = (event: string) => (err: unknown) => {
      console.error(JSON.stringify({ event, message: err instanceof Error ? err.message : String(err) }));
    };
    ctx.waitUntil(processPendingPages(env, null, config.indexBatchSize).then(() => {}, logFailure('cron.failed')));

    if (config.queryRetentionDays > 0 && new Date(controller.scheduledTime).getUTCMinutes() === 0) {
      ctx.waitUntil(
        new Db(env.DB)
          .pruneQueries(config.queryRetentionDays)
          .then((deleted) => {
            if (deleted > 0) console.log(JSON.stringify({ event: 'queries.pruned', deleted }));
          }, logFailure('queries.prune_failed')),
      );
    }

    const minute = Math.floor(controller.scheduledTime / 60_000);
    ctx.waitUntil(
      loadSettings(env)
        .then((settings) => {
          if (settings.mcp.socialMode === 'off' || minute % settings.mcp.pollIntervalMinutes !== 0) return;
          return pollSocialInbox(env, config, settings).then(() => {});
        })
        .then(() => {}, logFailure('social.poll_failed')),
    );
  },
} satisfies ExportedHandler<Env>;
