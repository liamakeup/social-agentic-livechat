/** Numeric / boolean configuration from environment variables, with defaults and bounds applied. */
import type { AppConfig, Env } from './types';
import { parseAllowedOrigins } from './utils/cors';

export function intVar(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number.parseInt(value ?? '', 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function boolVar(value: string | undefined, fallback: boolean): boolean {
  const v = value?.trim().toLowerCase();
  if (!v) return fallback;
  return !['0', 'false', 'no', 'off'].includes(v);
}

export function loadConfig(env: Env): AppConfig {
  return {
    maxPages: intVar(env.MAX_PAGES, 200, 1, 5000),
    indexBatchSize: intVar(env.INDEX_BATCH_SIZE, 3, 1, 50),
    topK: intVar(env.TOP_K, 4, 1, 20),
    rerank: boolVar(env.RERANK, true),
    allowedOrigins: parseAllowedOrigins(env.ALLOWED_ORIGINS),
    dailyChatLimit: intVar(env.DAILY_CHAT_LIMIT, 250, 0, 1_000_000),
    queryRetentionDays: intVar(env.QUERY_RETENTION_DAYS, 90, 0, 36_500),
  };
}
