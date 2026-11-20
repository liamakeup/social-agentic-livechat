/** Request helpers shared by the route modules: body parsing, validation and the admin guard. */
import type { Context, MiddlewareHandler } from 'hono';
import { Db, type SiteRow } from './db/schema';
import { timingSafeEqual } from './utils/hash';
import { HttpError, type AppBindings, type ChatMessage } from './types';

const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const MAX_HISTORY_ENTRIES = 10;
export const MAX_QUESTION_CHARS = 1000;
/**
 * Example ADMIN_TOKEN values shipped in .dev.vars.example (which the Deploy to Cloudflare wizard
 * pre-fills). They, and anything shorter than MIN_ADMIN_TOKEN_CHARS, only work on localhost.
 */
const PLACEHOLDER_ADMIN_TOKENS = new Set(['dev-token-change-me']);
const MIN_ADMIN_TOKEN_CHARS = 16;

export async function readJson<T>(c: Context<AppBindings>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new HttpError(400, 'Request body must be valid JSON', 'invalid_json');
  }
}

export function isSiteId(value: unknown): value is string {
  return typeof value === 'string' && SITE_ID_PATTERN.test(value);
}

export function requireSiteId(value: unknown): string {
  if (!isSiteId(value)) {
    throw new HttpError(
      400,
      'siteId must be 1-64 characters of letters, numbers, "-" or "_"',
      'invalid_site_id',
    );
  }
  return value.toLowerCase();
}

export function requireHttpUrl(value: unknown, field: string): URL {
  if (typeof value !== 'string') throw new HttpError(400, `${field} is required`, 'invalid_url');
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, `${field} must be an absolute URL`, 'invalid_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new HttpError(400, `${field} must use http or https`, 'invalid_url');
  }
  return url;
}

/** Validate a chat question (trimmed, non-empty, bounded). */
export function requireQuestion(value: unknown): string {
  const question = typeof value === 'string' ? value.trim() : '';
  if (!question) throw new HttpError(400, 'question is required', 'invalid_question');
  if (question.length > MAX_QUESTION_CHARS) {
    throw new HttpError(400, `question must be at most ${MAX_QUESTION_CHARS} characters`, 'invalid_question');
  }
  return question;
}

export function sanitizeHistory(value: unknown): ChatMessage[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (m): m is ChatMessage =>
        !!m &&
        typeof m === 'object' &&
        (m.role === 'user' || m.role === 'assistant') &&
        typeof m.content === 'string' &&
        m.content.trim().length > 0,
    )
    .slice(-MAX_HISTORY_ENTRIES);
}

/** True for requests served by `wrangler dev` (the URL host is the one Cloudflare routed on, not spoofable). */
export function isLocalRequest(url: string): boolean {
  const host = new URL(url).hostname;
  return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
}

export async function requireSite(db: Db, siteId: string): Promise<SiteRow> {
  const site = await db.getSite(siteId);
  if (!site) throw new HttpError(404, `Site "${siteId}" is not registered`, 'site_not_found');
  return site;
}

/** Bearer-token guard for management routes. */
export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  const expected = c.env.ADMIN_TOKEN;
  if (!expected) {
    throw new HttpError(
      503,
      'ADMIN_TOKEN is not configured. Run `bunx wrangler secret put ADMIN_TOKEN` (or add it to .dev.vars).',
      'admin_token_missing',
    );
  }
  if (
    (expected.length < MIN_ADMIN_TOKEN_CHARS || PLACEHOLDER_ADMIN_TOKENS.has(expected)) &&
    !isLocalRequest(c.req.url)
  ) {
    throw new HttpError(
      503,
      `ADMIN_TOKEN is the example value or shorter than ${MIN_ADMIN_TOKEN_CHARS} characters. ` +
        'Set a long random one with `bunx wrangler secret put ADMIN_TOKEN` (e.g. `openssl rand -hex 32`).',
      'admin_token_weak',
    );
  }
  const header = c.req.header('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !timingSafeEqual(token, expected)) {
    throw new HttpError(401, 'Invalid or missing admin token', 'unauthorized');
  }
  await next();
};
