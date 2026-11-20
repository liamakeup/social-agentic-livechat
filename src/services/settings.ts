/**
 * Admin-editable settings stored in D1 (`app_settings`), layered over environment variables.
 *
 * Every field has a default; the matching env var (if any) overrides it, and a D1 row overrides both.
 * Secret fields (fallback.apiKey, mcp.token) are stored AES-GCM encrypted and are never returned by
 * the API: the public view only reports whether they are set.
 */
import { HttpError, type Env } from '../types';
import { PROVIDER_STRATEGIES, isAllowedProviderUrl, type FallbackConfig, type ProviderStrategy } from './ai';

export type SocialMode = 'off' | 'draft' | 'auto';
export const SOCIAL_MODES: readonly SocialMode[] = ['off', 'draft', 'auto'];

export interface McpSettings {
  url: string;
  token: string;
  /** Proxy tool wrapping hidden tools, e.g. Zernio's "call_tool" ("" = call tools directly). */
  proxyTool: string;
  socialSiteId: string;
  socialMode: SocialMode;
  pollIntervalMinutes: number;
  maxRepliesPerTick: number;
  accountId: string;
  toolListConversations: string;
  toolListMessages: string;
  toolSendMessage: string;
  /** ISO time social replies were switched on; older customer messages are never answered. */
  socialEnabledAt: string | null;
}

export interface AppSettings {
  prompt: { systemPrompt: string };
  fallback: FallbackConfig;
  mcp: McpSettings;
  /**
   * Secret keys ("fallback.apiKey", "mcp.token") whose stored value no longer decrypts (SETTINGS_KEY or,
   * without it, ADMIN_TOKEN changed). They are treated as unset until saved again.
   */
  undecryptable?: string[];
}

/** Shape returned by GET/POST /api/settings: secrets replaced by "is set" flags. */
export interface PublicSettings {
  prompt: { systemPrompt: string };
  fallback: { strategy: ProviderStrategy; baseUrl: string; model: string; apiKeySet: boolean; apiKeyUndecryptable: boolean };
  mcp: Omit<McpSettings, 'token'> & { tokenSet: boolean; tokenUndecryptable: boolean };
}

export const MAX_SYSTEM_PROMPT_CHARS = 4000;
const MAX_SECRET_CHARS = 4096;
const MAX_TEXT_CHARS = 200;
const TOOL_NAME_PATTERN = /^[A-Za-z0-9_.:\/-]{1,128}$/;
const SITE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,63}$/i;
const SECRET_KEYS = new Set(['fallback.apiKey', 'mcp.token']);

export function defaultSettings(env: Env): AppSettings {
  const strategy = PROVIDER_STRATEGIES.includes(env.AI_PROVIDER_STRATEGY as ProviderStrategy)
    ? (env.AI_PROVIDER_STRATEGY as ProviderStrategy)
    : 'cf-first';
  return {
    prompt: { systemPrompt: '' },
    fallback: {
      strategy,
      baseUrl: env.FALLBACK_BASE_URL?.trim() ?? '',
      apiKey: env.FALLBACK_API_KEY?.trim() ?? '',
      model: env.FALLBACK_MODEL?.trim() ?? '',
    },
    mcp: {
      url: env.MCP_URL?.trim() ?? '',
      token: env.MCP_TOKEN?.trim() ?? '',
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
  };
}

// ---------------------------------------------------------------------------
// Secret encryption (AES-GCM, key = SHA-256("docflare-settings:" + SETTINGS_KEY || ADMIN_TOKEN))
// ---------------------------------------------------------------------------

const encoder = new TextEncoder();

function keyMaterial(env: Env): string | null {
  return env.SETTINGS_KEY || env.ADMIN_TOKEN || null;
}

async function cryptoKey(env: Env): Promise<CryptoKey | null> {
  const material = keyMaterial(env);
  if (!material) return null;
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(`docflare-settings:${material}`));
  return crypto.subtle.importKey('raw', digest, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

function toBase64(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function encryptSecret(env: Env, plaintext: string): Promise<string> {
  const key = await cryptoKey(env);
  if (!key) throw new HttpError(503, 'Set SETTINGS_KEY or ADMIN_TOKEN before saving secrets', 'settings_key_missing');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext)));
  return `v1:${toBase64(iv)}:${toBase64(ct)}`;
}

/** Decrypt a stored secret; null when the key changed or the value is malformed. */
export async function decryptSecret(env: Env, stored: string): Promise<string | null> {
  if (stored === '') return '';
  const [version, iv, ct] = stored.split(':');
  if (version !== 'v1' || !iv || !ct) return null;
  try {
    const key = await cryptoKey(env);
    if (!key) return null;
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(ct));
    return new TextDecoder().decode(plain);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Load / save
// ---------------------------------------------------------------------------

type Group = 'prompt' | 'fallback' | 'mcp';

function setField(settings: AppSettings, key: string, value: unknown): void {
  const [group, field] = key.split('.') as [Group, string];
  const target = settings[group] as unknown as Record<string, unknown> | undefined;
  if (!target || !field || !(field in target)) return;
  const current = target[field];
  // Only accept stored values of the expected type, so a bad row can never break the app.
  if (field === 'socialEnabledAt' ? typeof value === 'string' : typeof current === typeof value) {
    target[field] = value;
  }
}

/**
 * Effective settings: defaults ← env ← D1. When the table does not exist yet (migration 0002 not
 * applied) the env-based defaults are returned so chat keeps working.
 */
export async function loadSettings(env: Env): Promise<AppSettings> {
  const settings = defaultSettings(env);
  let rows: Array<{ key: string; value: string }>;
  try {
    rows = (await env.DB.prepare('SELECT key, value FROM app_settings').all<{ key: string; value: string }>()).results;
  } catch (err) {
    console.warn(
      JSON.stringify({ event: 'settings.load_failed', message: err instanceof Error ? err.message : String(err) }),
    );
    return settings;
  }
  for (const row of rows) {
    let value: unknown;
    try {
      value = JSON.parse(row.value);
    } catch {
      continue;
    }
    if (SECRET_KEYS.has(row.key)) {
      if (typeof value !== 'string') continue;
      const plain = await decryptSecret(env, value);
      if (plain === null) {
        console.warn(JSON.stringify({ event: 'settings.decrypt_failed', key: row.key }));
        (settings.undecryptable ??= []).push(row.key);
        value = '';
      } else {
        value = plain;
      }
    }
    setField(settings, row.key, value);
  }
  return settings;
}

export function toPublicSettings(settings: AppSettings): PublicSettings {
  const { apiKey, ...fallback } = settings.fallback;
  const { token, ...mcp } = settings.mcp;
  const undecryptable = new Set(settings.undecryptable ?? []);
  return {
    prompt: { ...settings.prompt },
    fallback: {
      strategy: fallback.strategy,
      baseUrl: fallback.baseUrl,
      model: fallback.model,
      apiKeySet: !!apiKey,
      apiKeyUndecryptable: undecryptable.has('fallback.apiKey'),
    },
    mcp: { ...mcp, tokenSet: !!token, tokenUndecryptable: undecryptable.has('mcp.token') },
  };
}

// ---------------------------------------------------------------------------
// Validation of POST /api/settings
// ---------------------------------------------------------------------------

function invalid(message: string): never {
  throw new HttpError(400, message, 'invalid_settings');
}

function group(body: Record<string, unknown>, name: Group): Record<string, unknown> | null {
  const value = body[name];
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) invalid(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function str(obj: Record<string, unknown>, field: string, path: string, max = MAX_TEXT_CHARS): string | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string') invalid(`${path} must be a string`);
  const trimmed = value.trim();
  if (trimmed.length > max) invalid(`${path} must be at most ${max} characters`);
  return trimmed;
}

function url(obj: Record<string, unknown>, field: string, path: string): string | undefined {
  const value = str(obj, field, path, 2048);
  if (value && !isAllowedProviderUrl(value)) invalid(`${path} must be an https URL`);
  return value;
}

function int(obj: Record<string, unknown>, field: string, path: string, min: number, max: number): number | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    invalid(`${path} must be an integer between ${min} and ${max}`);
  }
  return value;
}

function oneOf<T extends string>(obj: Record<string, unknown>, field: string, path: string, allowed: readonly T[]): T | undefined {
  const value = obj[field];
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !allowed.includes(value as T)) invalid(`${path} must be one of ${allowed.join(', ')}`);
  return value as T;
}

function toolName(obj: Record<string, unknown>, field: string, path: string, optional = false): string | undefined {
  const value = str(obj, field, path, 128);
  if (value === undefined) return undefined;
  if (value === '' && optional) return value;
  if (!TOOL_NAME_PATTERN.test(value)) invalid(`${path} must be a tool name (letters, digits, _ . : / -)`);
  return value;
}

/**
 * Secret semantics: omitted or "" keeps the stored value, null clears it, any other string replaces it.
 * Returns undefined (keep), null (clear) or the new value.
 */
function secret(obj: Record<string, unknown>, field: string, path: string): string | null | undefined {
  const value = obj[field];
  if (value === undefined || value === '') return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') invalid(`${path} must be a string or null`);
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_SECRET_CHARS) invalid(`${path} is too long`);
  return trimmed;
}

/** Validated changes: plain values keyed "group.field"; secrets as new value or null (clear). */
export interface SettingsPatch {
  values: Map<string, string | number | null>;
  secrets: Map<string, string | null>;
}

export function parseSettingsPatch(body: unknown): SettingsPatch {
  if (!body || typeof body !== 'object' || Array.isArray(body)) invalid('Body must be a JSON object');
  const root = body as Record<string, unknown>;
  const values = new Map<string, string | number | null>();
  const secrets = new Map<string, string | null>();
  const put = (key: string, value: string | number | undefined) => {
    if (value !== undefined) values.set(key, value);
  };

  const prompt = group(root, 'prompt');
  if (prompt) put('prompt.systemPrompt', str(prompt, 'systemPrompt', 'prompt.systemPrompt', MAX_SYSTEM_PROMPT_CHARS));

  const fallback = group(root, 'fallback');
  if (fallback) {
    put('fallback.strategy', oneOf(fallback, 'strategy', 'fallback.strategy', PROVIDER_STRATEGIES));
    put('fallback.baseUrl', url(fallback, 'baseUrl', 'fallback.baseUrl'));
    put('fallback.model', str(fallback, 'model', 'fallback.model'));
    const apiKey = secret(fallback, 'apiKey', 'fallback.apiKey');
    if (apiKey !== undefined) secrets.set('fallback.apiKey', apiKey);
  }

  const mcp = group(root, 'mcp');
  if (mcp) {
    put('mcp.url', url(mcp, 'url', 'mcp.url'));
    put('mcp.proxyTool', toolName(mcp, 'proxyTool', 'mcp.proxyTool', true));
    const siteId = str(mcp, 'socialSiteId', 'mcp.socialSiteId', 64);
    if (siteId && !SITE_ID_PATTERN.test(siteId)) invalid('mcp.socialSiteId is not a valid site id');
    put('mcp.socialSiteId', siteId?.toLowerCase());
    put('mcp.socialMode', oneOf(mcp, 'socialMode', 'mcp.socialMode', SOCIAL_MODES));
    put('mcp.pollIntervalMinutes', int(mcp, 'pollIntervalMinutes', 'mcp.pollIntervalMinutes', 1, 60));
    put('mcp.maxRepliesPerTick', int(mcp, 'maxRepliesPerTick', 'mcp.maxRepliesPerTick', 1, 10));
    put('mcp.accountId', str(mcp, 'accountId', 'mcp.accountId'));
    put('mcp.toolListConversations', toolName(mcp, 'toolListConversations', 'mcp.toolListConversations'));
    put('mcp.toolListMessages', toolName(mcp, 'toolListMessages', 'mcp.toolListMessages'));
    put('mcp.toolSendMessage', toolName(mcp, 'toolSendMessage', 'mcp.toolSendMessage'));
    const token = secret(mcp, 'token', 'mcp.token');
    if (token !== undefined) secrets.set('mcp.token', token);
  }
  return { values, secrets };
}

/** Host (with port) of a URL, or null when empty / unparsable. */
function hostOf(value: string): string | null {
  if (!value) return null;
  try {
    return new URL(value).host.toLowerCase();
  } catch {
    return null;
  }
}

/**
 * Validate a patch against the resulting settings and persist it. A secret set to null is stored as
 * "" so it also overrides the env var. Turning social replies on records `mcp.socialEnabledAt`.
 * Changing the effective `mcp.url` host (to another host, or clearing the URL) without supplying a token
 * clears the stored MCP token, so a token is never sent to a server it was not entered for.
 */
export async function saveSettings(
  env: Env,
  patch: SettingsPatch,
  siteExists: (siteId: string) => Promise<boolean>,
): Promise<AppSettings> {
  const before = await loadSettings(env);
  const secrets = new Map(patch.secrets);
  const next: AppSettings = structuredClone(before);
  for (const [key, value] of patch.values) setField(next, key, value);
  // The stored token belongs to the host it was entered with (the current one). Any change of the
  // effective host, to another server or to none, drops it unless this save brings a new token.
  const hasToken = !!before.mcp.token || (before.undecryptable ?? []).includes('mcp.token');
  if (!secrets.has('mcp.token') && hasToken && hostOf(next.mcp.url) !== hostOf(before.mcp.url)) {
    secrets.set('mcp.token', null);
  }
  // A secret saved again decrypts with the current key.
  next.undecryptable = (before.undecryptable ?? []).filter((key) => !secrets.has(key));
  for (const [key, value] of secrets) setField(next, key, value ?? '');

  if (next.mcp.socialMode !== 'off') {
    if (!next.mcp.url) invalid('mcp.url is required when social replies are on');
    if (!next.mcp.socialSiteId) invalid('mcp.socialSiteId is required when social replies are on');
    if (!(await siteExists(next.mcp.socialSiteId))) invalid(`Site "${next.mcp.socialSiteId}" is not registered`);
  }
  const rows = new Map<string, string>();
  for (const [key, value] of patch.values) rows.set(key, JSON.stringify(value));
  for (const [key, value] of secrets) {
    rows.set(key, JSON.stringify(value === null ? '' : await encryptSecret(env, value)));
  }
  if (before.mcp.socialMode === 'off' && next.mcp.socialMode !== 'off') {
    next.mcp.socialEnabledAt = new Date().toISOString();
    rows.set('mcp.socialEnabledAt', JSON.stringify(next.mcp.socialEnabledAt));
  }
  if (rows.size > 0) {
    const sql = `INSERT INTO app_settings (key, value, updated_at) VALUES (?1, ?2, CURRENT_TIMESTAMP)
      ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`;
    await env.DB.batch([...rows].map(([key, value]) => env.DB.prepare(sql).bind(key, value)));
  }
  return next;
}
