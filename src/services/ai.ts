/**
 * Workers AI helpers: embeddings, RAG prompt construction and text generation.
 * Everything runs through the `AI` binding; an optional OpenAI-compatible provider (plain `fetch`)
 * can take over text generation when Workers AI fails or is out of quota.
 */
import type { ChatMessage, RetrievedChunk, Source } from '../types';

/**
 * Multilingual embedding model (100+ languages): a Vietnamese question finds Vietnamese or English pages.
 * Changing it requires a Vectorize index with EMBEDDING_DIMENSIONS dimensions and a re-crawl of every site.
 */
export const EMBEDDING_MODEL = '@cf/baai/bge-m3';
// `@cf/meta/llama-3.1-8b-instruct` was deprecated by Cloudflare on 2026-05-30 (AiError 5028); the fp8 build is the drop-in.
export const CHAT_MODEL = '@cf/meta/llama-3.1-8b-instruct-fp8';
/** Cross-encoder used to re-order the vector-search candidates before they reach the LLM. */
export const RERANK_MODEL = '@cf/baai/bge-reranker-base';
export const EMBEDDING_DIMENSIONS = 1024;

/** Texts per embedding call. bge-m3 documents no item limit; 50 keeps each request modest. */
const EMBED_BATCH_SIZE = 50;
/** Longest passage handed to the reranker (its window is ~512 tokens for query + passage). */
const RERANK_MAX_CHARS = 2000;
/** Generation settings tuned for factual, grounded answers. */
const MAX_OUTPUT_TOKENS = 768;
const TEMPERATURE = 0.2;
/** Keep the prompt well inside the model's ~8k token context window. */
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_CHARS = 1500;
/**
 * Appended to the user's question. Small models follow the language of the chat history (or of the
 * excerpts) over a system rule; a reminder right next to the question is what reliably works.
 */
export const LANGUAGE_REMINDER = '(Answer in the same language as this question.)';

/** Minimal structural view of the AI binding, decoupled from model-specific generics. */
type AiRunner = {
  run(model: string, inputs: Record<string, unknown>): Promise<unknown>;
};

type EmbeddingOutput = { shape?: number[]; data?: number[][] };
/**
 * Text generation output. Llama-family models return `{ response }`; OpenAI-compatible models
 * (GLM, Gemma 4, gpt-oss, ...) return `{ choices: [{ message: { content } }] }` and stream
 * `{ choices: [{ delta: { content } }] }`. Both shapes are accepted so CHAT_MODEL can be swapped.
 */
type TextGenerationOutput = {
  response?: string;
  choices?: Array<{ message?: { content?: string | null }; delta?: { content?: string | null } }>;
};

/** Answer text from either output shape ("" when absent). */
export function outputText(output: TextGenerationOutput | undefined): string {
  if (!output) return '';
  if (typeof output.response === 'string') return output.response;
  const choice = output.choices?.[0];
  return choice?.message?.content ?? choice?.delta?.content ?? '';
}

/** Raised when Workers AI reports a quota / rate limit problem. Mapped to HTTP 429. */
export class AiRateLimitError extends Error {
  constructor(message = 'Workers AI rate limit or daily quota reached. Please try again later.') {
    super(message);
    this.name = 'AiRateLimitError';
  }
}

export function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  // Workers AI error codes 3040 (rate limited) / 3036 (account limited) plus generic phrasing.
  return /rate.?limit|too many requests|\b429\b|\b3040\b|\b3036\b|daily limit|quota|capacity/i.test(msg);
}

function wrapAiError(err: unknown): never {
  if (isRateLimitError(err)) throw new AiRateLimitError();
  throw err instanceof Error ? err : new Error(String(err));
}

// ---------------------------------------------------------------------------
// Embeddings
// ---------------------------------------------------------------------------

/** Embed a list of texts (batched). Returns one EMBEDDING_DIMENSIONS vector per input, in order. */
export async function embedTexts(ai: Ai, texts: string[]): Promise<number[][]> {
  const runner = ai as unknown as AiRunner;
  const vectors: number[][] = [];

  for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
    const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
    let output: EmbeddingOutput;
    try {
      output = (await runner.run(EMBEDDING_MODEL, { text: batch, truncate_inputs: true })) as EmbeddingOutput;
    } catch (err) {
      wrapAiError(err);
    }
    const data = output.data;
    if (!Array.isArray(data) || data.length !== batch.length) {
      throw new Error(`Embedding model returned ${data?.length ?? 0} vectors for ${batch.length} inputs`);
    }
    for (const vec of data) {
      if (vec.length !== EMBEDDING_DIMENSIONS) {
        throw new Error(`Unexpected embedding size ${vec.length}, expected ${EMBEDDING_DIMENSIONS}`);
      }
      vectors.push(vec);
    }
  }
  return vectors;
}

/** Embed a single query string. */
export async function embedQuery(ai: Ai, text: string): Promise<number[]> {
  const [vector] = await embedTexts(ai, [text]);
  if (!vector) throw new Error('Embedding model returned no vector');
  return vector;
}

// ---------------------------------------------------------------------------
// Reranking
// ---------------------------------------------------------------------------

/** bge-reranker output: one relevance score (sigmoid, 0-1) per context index. */
type RerankOutput = { response?: Array<{ id?: number; score?: number }> };

/**
 * Re-order candidates with the reranker's scores. Pure and defensive: malformed or empty output
 * leaves the input order untouched; contexts the model did not score keep their vector order after
 * the scored ones. Each returned chunk carries the reranker score in `score`.
 */
export function applyRerank(chunks: RetrievedChunk[], output: RerankOutput | undefined): RetrievedChunk[] {
  const entries = output?.response;
  if (!Array.isArray(entries)) return chunks;
  const scored: RetrievedChunk[] = [];
  const seen = new Set<number>();
  for (const entry of entries) {
    const id = entry?.id;
    const score = entry?.score;
    const chunk = typeof id === 'number' ? chunks[id] : undefined;
    if (!chunk || typeof score !== 'number' || !Number.isFinite(score) || seen.has(id as number)) continue;
    seen.add(id as number);
    scored.push({ ...chunk, score });
  }
  if (scored.length === 0) return chunks;
  scored.sort((a, b) => b.score - a.score);
  chunks.forEach((chunk, i) => {
    if (!seen.has(i)) scored.push(chunk);
  });
  return scored;
}

/**
 * Second retrieval stage: score every candidate against the question with a cross-encoder and sort
 * by that score. Bi-encoder similarity alone tends to favour chunks that merely share vocabulary
 * with the question (e.g. the site name on legal pages); the reranker reads question and passage
 * together and promotes the paragraph that actually answers it. Any failure (rate limit, model
 * error, odd output) falls back to the vector order so chat keeps working.
 */
export async function rerankChunks(ai: Ai, query: string, chunks: RetrievedChunk[]): Promise<RetrievedChunk[]> {
  if (chunks.length < 2) return chunks;
  const runner = ai as unknown as AiRunner;
  let output: RerankOutput;
  try {
    output = (await runner.run(RERANK_MODEL, {
      query,
      contexts: chunks.map((chunk) => ({ text: chunk.metadata.text.slice(0, RERANK_MAX_CHARS) })),
      top_k: chunks.length,
    })) as RerankOutput;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(JSON.stringify({ event: 'rerank.failed', message }));
    return chunks;
  }
  return applyRerank(chunks, output);
}

// ---------------------------------------------------------------------------
// RAG prompt
// ---------------------------------------------------------------------------

/** First line of the system prompt; replaced by the admin-configured persona when one is set. */
const DEFAULT_PERSONA = 'You are a friendly and precise assistant for {{DOMAIN}}.';

const SYSTEM_PROMPT_RULES = `Rules:
- Answer ONLY using the documentation excerpts below. Never guess or use outside knowledge.
- Reply in the language of the user's question (English question -> English answer, Vietnamese question -> Vietnamese answer), even when the excerpts are written in a different language. Translate the facts you use.
- Answer directly, as if you knew the documentation yourself. Do not quote or list the excerpts, do not mention "the context", "the excerpts" or "the provided information", and do not add citation markers such as [1]. The sources are shown to the user separately.
- If the excerpts do not contain the answer, say so briefly and suggest what the user could search for instead.
- Never invent URLs, commands, flags, settings or version numbers that are not in the excerpts.
- Be concise. Use Markdown: short paragraphs, bullet lists, and fenced code blocks for commands or code.

Documentation excerpts:
{{CONTEXT}}`;

/** Convert retrieved chunks into sources (1-based, relevance order, same order as the context). */
export function toSources(chunks: RetrievedChunk[]): Source[] {
  return chunks.map((chunk, i) => ({
    index: i + 1,
    url: chunk.metadata.url,
    title: chunk.metadata.title || chunk.metadata.url,
    score: Number(chunk.score.toFixed(4)),
  }));
}

/** Build the chat messages array for the generation model. */
export function buildRagMessages(
  question: string,
  chunks: RetrievedChunk[],
  history: ChatMessage[] = [],
  domain = 'this website',
  persona = '',
): Array<{ role: 'system' | 'user' | 'assistant'; content: string }> {
  const context =
    chunks.length === 0
      ? '(no relevant documentation found)'
      : chunks
          .map((chunk) => {
            const title = chunk.metadata.title || chunk.metadata.url;
            const where = /^https?:/i.test(chunk.metadata.url) ? ` (${chunk.metadata.url})` : '';
            return `Source: ${title}${where}\n${chunk.metadata.text}`;
          })
          .join('\n\n---\n\n');

  // Function replacers: domain, persona and page text must never be read as `$&`-style patterns.
  const firstLine = persona.trim() || DEFAULT_PERSONA.replace('{{DOMAIN}}', () => domain);
  const system = `${firstLine}\n\n${SYSTEM_PROMPT_RULES.replace('{{CONTEXT}}', () => context)}`;

  const trimmedHistory = history
    .slice(-MAX_HISTORY_TURNS)
    .filter((m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_HISTORY_CHARS) }));

  return [
    { role: 'system', content: system },
    ...trimmedHistory,
    { role: 'user', content: `${question}\n\n${LANGUAGE_REMINDER}` },
  ];
}

// ---------------------------------------------------------------------------
// Generation
// ---------------------------------------------------------------------------

/** Generate a complete answer (non-streaming). */
export async function generateAnswer(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const runner = ai as unknown as AiRunner;
  try {
    const output = (await runner.run(CHAT_MODEL, {
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
    })) as TextGenerationOutput;
    return outputText(output).trim();
  } catch (err) {
    wrapAiError(err);
  }
}

/**
 * Generate an answer as a stream. Workers AI returns Server-Sent Events of the form
 * `data: {"response":"token"}` terminated by `data: [DONE]`.
 */
export async function generateAnswerStream(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
): Promise<ReadableStream<Uint8Array>> {
  const runner = ai as unknown as AiRunner;
  try {
    const output = await runner.run(CHAT_MODEL, {
      messages,
      max_tokens: MAX_OUTPUT_TOKENS,
      temperature: TEMPERATURE,
      stream: true,
    });
    if (!(output instanceof ReadableStream)) {
      // Some environments ignore `stream: true`; fall back to a one-shot stream.
      const text = outputText(output as TextGenerationOutput).trim();
      return textToWorkersAiStream(text);
    }
    return output as ReadableStream<Uint8Array>;
  } catch (err) {
    wrapAiError(err);
  }
}

/** Wrap a plain string into the same SSE shape Workers AI emits, for uniform downstream handling. */
export function textToWorkersAiStream(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(`data: ${JSON.stringify({ response: text })}\n\n`));
      controller.enqueue(encoder.encode('data: [DONE]\n\n'));
      controller.close();
    },
  });
}

/**
 * Extract the `response` tokens from a Workers AI SSE byte stream and yield them as strings.
 * Handles chunk boundaries that split a line and a last line without a trailing newline.
 * Stopping early (consumer breaks out, `[DONE]`, error) cancels the upstream stream.
 */
export async function* iterateWorkersAiTokens(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let drained = false;

  try {
    while (!drained) {
      const { done, value } = await reader.read();
      if (done) {
        drained = true;
        buffer += decoder.decode() + '\n';
      } else {
        buffer += decoder.decode(value, { stream: true });
      }

      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return;
        let token = '';
        try {
          token = outputText(JSON.parse(payload) as TextGenerationOutput);
        } catch {
          // Ignore malformed keep-alive lines.
        }
        if (token) yield token;
      }
    }
  } finally {
    if (!drained) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// OpenAI-compatible fallback provider + hybrid routing
// ---------------------------------------------------------------------------

export type ProviderStrategy = 'cf-first' | 'external-first' | 'cf-only' | 'external-only';
export const PROVIDER_STRATEGIES: readonly ProviderStrategy[] = ['cf-first', 'external-first', 'cf-only', 'external-only'];

/** Text-generation routing. External is used only when baseUrl, apiKey and model are all set. */
export interface FallbackConfig {
  strategy: ProviderStrategy;
  baseUrl: string;
  apiKey: string;
  model: string;
}

/** Workers AI non-streaming calls slower than this count as failed when a fallback is available. */
export const CF_TIMEOUT_MS = 25_000;
/** Whole-request budget for a non-streaming external call (time to first byte for streaming). */
const EXTERNAL_TIMEOUT_MS = 30_000;
/** Longest silence allowed between two chunks of an external stream before it is abandoned. */
export const EXTERNAL_STREAM_IDLE_MS = 20_000;

/** Raised when the external provider fails. Message carries the HTTP status only, never the key or body. */
export class ExternalAiError extends Error {
  constructor(
    message: string,
    public readonly status = 0,
  ) {
    super(message);
    this.name = 'ExternalAiError';
  }
}

export function isExternalConfigured(config: FallbackConfig | undefined): config is FallbackConfig {
  return !!config && !!config.baseUrl && !!config.apiKey && !!config.model;
}

/** True for https URLs, and http URLs pointing at localhost (local proxies during development). */
export function isAllowedProviderUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') return true;
  return url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
}

/** Provider order for a strategy; Workers AI only when the external provider is not configured. */
function providerOrder(config: FallbackConfig | undefined): Array<'workers-ai' | 'external'> {
  if (!isExternalConfigured(config)) return ['workers-ai'];
  switch (config.strategy) {
    case 'external-first':
      return ['external', 'workers-ai'];
    case 'cf-only':
      return ['workers-ai'];
    case 'external-only':
      return ['external'];
    default:
      return ['workers-ai', 'external'];
  }
}

function errorReason(err: unknown): string {
  if (err instanceof ExternalAiError) return err.message;
  if (err instanceof AiRateLimitError) return 'rate_limited';
  if (err instanceof Error) return `${err.name}: ${err.message}`.slice(0, 200);
  return String(err).slice(0, 200);
}

function chatCompletionsUrl(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * POST a chat completion. The timeout covers the response headers; for non-streaming calls the caller
 * keeps the same signal while reading the body. A 429 becomes AiRateLimitError like Workers AI's.
 */
async function postExternal(
  config: FallbackConfig,
  messages: Array<{ role: string; content: string }>,
  stream: boolean,
): Promise<{ response: Response; clear: () => void }> {
  if (!isAllowedProviderUrl(config.baseUrl)) throw new ExternalAiError('External LLM base URL must use https');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), EXTERNAL_TIMEOUT_MS);
  const clear = () => clearTimeout(timer);
  let response: Response;
  try {
    response = await fetch(chatCompletionsUrl(config.baseUrl), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: JSON.stringify({
        model: config.model,
        messages,
        max_tokens: MAX_OUTPUT_TOKENS,
        temperature: TEMPERATURE,
        stream,
      }),
      signal: controller.signal,
    });
  } catch (err) {
    clear();
    const aborted = err instanceof Error && err.name === 'AbortError';
    throw new ExternalAiError(aborted ? 'External LLM timed out' : 'External LLM request failed');
  }
  if (!response.ok) {
    clear();
    await response.body?.cancel().catch(() => {});
    if (response.status === 429) throw new AiRateLimitError();
    throw new ExternalAiError(`External LLM HTTP ${response.status}`, response.status);
  }
  return { response, clear };
}

/** Non-streaming answer from the OpenAI-compatible provider. */
export async function generateExternalAnswer(
  config: FallbackConfig,
  messages: Array<{ role: string; content: string }>,
): Promise<string> {
  const { response, clear } = await postExternal(config, messages, false);
  try {
    const output = (await response.json()) as TextGenerationOutput;
    const text = outputText(output).trim();
    if (!text) throw new ExternalAiError('External LLM returned an empty answer');
    return text;
  } catch (err) {
    if (err instanceof ExternalAiError) throw err;
    throw new ExternalAiError('External LLM returned an invalid response');
  } finally {
    clear();
  }
}

/**
 * Streaming answer from the OpenAI-compatible provider. The HTTP status is checked before the body is
 * returned, so a failing provider is detected while a fallback is still possible. The OpenAI SSE shape
 * (`choices[0].delta.content`) is understood by iterateWorkersAiTokens as is. A stream that stays
 * silent for `idleMs` between chunks errors (the chat stream then ends with its error event).
 */
export async function generateExternalAnswerStream(
  config: FallbackConfig,
  messages: Array<{ role: string; content: string }>,
  idleMs = EXTERNAL_STREAM_IDLE_MS,
): Promise<ReadableStream<Uint8Array>> {
  const { response, clear } = await postExternal(config, messages, true);
  const type = response.headers.get('Content-Type') ?? '';
  if (!type.includes('text/event-stream')) {
    // Provider ignored `stream: true`: wrap the one-shot answer, which must not be empty (an empty
    // answer is an error, so the next provider is tried). The request timeout still covers the body.
    let output: TextGenerationOutput;
    try {
      output = (await response.json()) as TextGenerationOutput;
    } catch {
      throw new ExternalAiError('External LLM returned an invalid response');
    } finally {
      clear();
    }
    const text = outputText(output).trim();
    if (!text) throw new ExternalAiError('External LLM returned an empty answer');
    return textToWorkersAiStream(text);
  }
  clear();
  if (!response.body) throw new ExternalAiError('External LLM returned no body');
  return withIdleTimeout(response.body, idleMs);
}

/** Pass `source` through, erroring (and cancelling `source`) when no chunk arrives for `idleMs`. */
export function withIdleTimeout(source: ReadableStream<Uint8Array>, idleMs: number): ReadableStream<Uint8Array> {
  const reader = source.getReader();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ExternalAiError(`External LLM stream stalled for ${idleMs} ms`)), idleMs);
      });
      try {
        const chunk = await Promise.race([reader.read(), idle]);
        if (chunk.done) controller.close();
        else controller.enqueue(chunk.value);
      } catch (err) {
        reader.cancel().catch(() => {});
        controller.error(err);
      } finally {
        clearTimeout(timer);
      }
    },
    cancel(reason) {
      return reader.cancel(reason);
    },
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Workers AI timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Try each provider in order; log every hand-over; rethrow the last provider's error. */
async function runWithFallback<T>(
  config: FallbackConfig | undefined,
  attempt: (provider: 'workers-ai' | 'external', hasNext: boolean) => Promise<T>,
): Promise<T> {
  const order = providerOrder(config);
  let lastError: unknown;
  for (let i = 0; i < order.length; i++) {
    const provider = order[i] as 'workers-ai' | 'external';
    const next = order[i + 1];
    try {
      return await attempt(provider, !!next);
    } catch (err) {
      lastError = err;
      if (!next) break;
      console.warn(JSON.stringify({ event: 'llm.fallback', from: provider, to: next, reason: errorReason(err) }));
    }
  }
  throw lastError;
}

/** Non-streaming answer routed by `config.strategy` (plain Workers AI when no fallback is configured). */
export async function generateHybridAnswer(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
  config?: FallbackConfig,
): Promise<string> {
  return runWithFallback(config, (provider, hasNext) => {
    if (provider === 'external') return generateExternalAnswer(config as FallbackConfig, messages);
    return hasNext ? withTimeout(generateAnswer(ai, messages), CF_TIMEOUT_MS) : generateAnswer(ai, messages);
  });
}

/**
 * Streaming answer routed by `config.strategy`. Fallback happens only when a provider fails before it
 * returns a stream; a stream that breaks midway ends with the chat stream's error event.
 */
export async function generateHybridAnswerStream(
  ai: Ai,
  messages: Array<{ role: string; content: string }>,
  config?: FallbackConfig,
): Promise<ReadableStream<Uint8Array>> {
  return runWithFallback(config, (provider) =>
    provider === 'external'
      ? generateExternalAnswerStream(config as FallbackConfig, messages)
      : generateAnswerStream(ai, messages),
  );
}
