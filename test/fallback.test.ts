/**
 * Hybrid text generation: Workers AI first with an OpenAI-compatible fallback, external-first,
 * the unconfigured (Workers AI only) behaviour, streaming fallback and OpenAI SSE parsing.
 */
import { afterEach, describe, expect, test } from 'bun:test';
import worker from '../src/index';
import {
  AiRateLimitError,
  ExternalAiError,
  generateExternalAnswerStream,
  generateHybridAnswer,
  generateHybridAnswerStream,
  iterateWorkersAiTokens,
  withIdleTimeout,
  type FallbackConfig,
} from '../src/services/ai';
import { buildChatStream } from '../src/services/stream';
import { createAi, createCtx, createEnv } from './helpers';

const BASE = 'https://llm.example.com/v1';
const KEY = 'sk-test-secret-key';
const EXTERNAL: FallbackConfig = { strategy: 'cf-first', baseUrl: BASE, apiKey: KEY, model: 'llama-70b' };
const MESSAGES = [{ role: 'user', content: 'hi' }];

type Call = { url: string; headers: Headers; body: Record<string, unknown> };

/** Mock the external provider; `respond` builds the response for each call. */
function mockExternal(respond: (call: Call) => Response) {
  const calls: Call[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const call = { url, headers: new Headers(init?.headers), body: JSON.parse(String(init?.body ?? '{}')) };
    calls.push(call);
    return respond(call);
  }) as typeof fetch;
  restore = () => {
    globalThis.fetch = original;
  };
  return calls;
}

let restore: () => void = () => {};
afterEach(() => restore());

const completion = (text: string) => Response.json({ choices: [{ message: { role: 'assistant', content: text } }] });

function sse(lines: string[]): Response {
  return new Response(lines.map((l) => `data: ${l}\n\n`).join(''), {
    headers: { 'Content-Type': 'text/event-stream' },
  });
}

async function collect(stream: ReadableStream<Uint8Array>): Promise<string> {
  let out = '';
  for await (const token of iterateWorkersAiTokens(stream)) out += token;
  return out;
}

const rateLimited = () => {
  throw new Error('3040: Capacity temporarily exceeded, rate limited');
};
const aiError = () => {
  const err = new Error('5028: model failure');
  err.name = 'AiError';
  throw err;
};

describe('generateHybridAnswer', () => {
  test('uses Workers AI when it works', async () => {
    const calls = mockExternal(() => completion('external'));
    const { ai } = createAi(() => ({ response: 'from cf' }));
    expect(await generateHybridAnswer(ai, MESSAGES, EXTERNAL)).toBe('from cf');
    expect(calls).toHaveLength(0);
  });

  test.each([
    ['rate limit', rateLimited],
    ['AiError', aiError],
  ])('falls back to the external provider on a Workers AI %s', async (_name, fail) => {
    const calls = mockExternal(() => completion('from external'));
    const { ai } = createAi(fail);
    expect(await generateHybridAnswer(ai, MESSAGES, EXTERNAL)).toBe('from external');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe(`${BASE}/chat/completions`);
    expect(calls[0]?.headers.get('Authorization')).toBe(`Bearer ${KEY}`);
    expect(calls[0]?.body.model).toBe('llama-70b');
    expect(calls[0]?.body.stream).toBe(false);
  });

  test('without a complete fallback config, Workers AI errors surface as before', async () => {
    const calls = mockExternal(() => completion('never'));
    const { ai } = createAi(rateLimited);
    await expect(generateHybridAnswer(ai, MESSAGES, { ...EXTERNAL, apiKey: '' })).rejects.toBeInstanceOf(AiRateLimitError);
    await expect(generateHybridAnswer(ai, MESSAGES)).rejects.toBeInstanceOf(AiRateLimitError);
    expect(calls).toHaveLength(0);
  });

  test('external-first uses the provider first and Workers AI when it fails', async () => {
    let status = 200;
    const calls = mockExternal(() => (status === 200 ? completion('ext') : new Response('boom', { status })));
    const { ai } = createAi(() => ({ response: 'cf' }));
    const config: FallbackConfig = { ...EXTERNAL, strategy: 'external-first' };

    expect(await generateHybridAnswer(ai, MESSAGES, config)).toBe('ext');
    status = 500;
    expect(await generateHybridAnswer(ai, MESSAGES, config)).toBe('cf');
    expect(calls).toHaveLength(2);
  });

  test('cf-only never calls the provider; external-only never calls Workers AI', async () => {
    const calls = mockExternal(() => completion('ext'));
    let cfCalls = 0;
    const { ai } = createAi(() => {
      cfCalls++;
      return { response: 'cf' };
    });
    expect(await generateHybridAnswer(ai, MESSAGES, { ...EXTERNAL, strategy: 'cf-only' })).toBe('cf');
    expect(await generateHybridAnswer(ai, MESSAGES, { ...EXTERNAL, strategy: 'external-only' })).toBe('ext');
    expect(cfCalls).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test('an external 429 maps to AiRateLimitError and error messages never contain the key', async () => {
    mockExternal(() => new Response(`invalid key ${KEY}`, { status: 429 }));
    const { ai } = createAi(() => ({ response: 'cf' }));
    const err = await generateHybridAnswer(ai, MESSAGES, { ...EXTERNAL, strategy: 'external-only' }).catch((e) => e);
    expect(err).toBeInstanceOf(AiRateLimitError);

    restore();
    mockExternal(() => new Response(`bad key ${KEY}`, { status: 401 }));
    const err2 = (await generateHybridAnswer(ai, MESSAGES, { ...EXTERNAL, strategy: 'external-only' }).catch(
      (e) => e,
    )) as Error;
    expect(err2.message).toBe('External LLM HTTP 401');
    expect(err2.message).not.toContain(KEY);
  });
});

describe('generateHybridAnswerStream', () => {
  test('falls back before streaming when Workers AI fails to start', async () => {
    const calls = mockExternal(() => sse([JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }), '{"choices":[{"delta":{"content":"lo"}}]}', '[DONE]']));
    const { ai } = createAi(rateLimited);
    const stream = await generateHybridAnswerStream(ai, MESSAGES, EXTERNAL);
    expect(await collect(stream)).toBe('Hello');
    expect(calls[0]?.body.stream).toBe(true);
  });

  test('an external HTTP error is detected before a stream is returned (external-first → Workers AI)', async () => {
    mockExternal(() => new Response('down', { status: 503 }));
    const { ai } = createAi(() => ({ response: 'cf answer' }));
    const stream = await generateHybridAnswerStream(ai, MESSAGES, { ...EXTERNAL, strategy: 'external-first' });
    expect(await collect(stream)).toBe('cf answer');
  });

  test('OpenAI SSE chunks (role-only deltas, split lines, no trailing newline) parse into tokens', async () => {
    const encoder = new TextEncoder();
    const parts = [
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n',
      'data: {"choices":[{"delta":{"con',
      'tent":"A"}}]}\n\ndata: {"choices":[{"delta":{"content":"B"}}]}\n\n',
      'data: [DONE]',
    ];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const p of parts) controller.enqueue(encoder.encode(p));
        controller.close();
      },
    });
    expect(await collect(stream)).toBe('AB');
  });
});

describe('external stream robustness', () => {
  test('an empty one-shot answer to a stream request is an error, so external-first falls back to Workers AI', async () => {
    const calls = mockExternal(() => Response.json({ choices: [] }));
    let cfCalls = 0;
    const { ai } = createAi(() => {
      cfCalls++;
      return { response: 'cf answer' };
    });
    const stream = await generateHybridAnswerStream(ai, MESSAGES, { ...EXTERNAL, strategy: 'external-first' });
    expect(await collect(stream)).toBe('cf answer');
    expect(calls).toHaveLength(1);
    expect(cfCalls).toBe(1);

    const err = await generateExternalAnswerStream(EXTERNAL, MESSAGES).catch((e) => e);
    expect(err).toBeInstanceOf(ExternalAiError);
    expect(err.message).toBe('External LLM returned an empty answer');
  });

  test('a non-empty one-shot answer is still wrapped as a stream', async () => {
    mockExternal(() => completion('one shot'));
    expect(await collect(await generateExternalAnswerStream(EXTERNAL, MESSAGES))).toBe('one shot');
  });

  test('a stream that goes silent errors after the idle timeout and is cancelled', async () => {
    let cancelled = false;
    mockExternal(
      () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
              // …then nothing more, and the connection stays open.
            },
            cancel() {
              cancelled = true;
            },
          }),
          { headers: { 'Content-Type': 'text/event-stream' } },
        ),
    );
    const stream = await generateExternalAnswerStream(EXTERNAL, MESSAGES, 30);
    let out = '';
    const err = await (async () => {
      for await (const token of iterateWorkersAiTokens(stream)) out += token;
    })().catch((e) => e);
    expect(out).toBe('Hi');
    expect(err).toBeInstanceOf(ExternalAiError);
    expect(err.message).toContain('stalled');
    expect(cancelled).toBe(true);
  });

  test('the chat stream ends with its error event when the external stream stalls', async () => {
    const source = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"Hi"}}]}\n\n'));
      },
    });
    const { stream, finished } = buildChatStream('id-1', [], withIdleTimeout(source, 30), async () => {});
    const text = await new Response(stream).text();
    await finished;
    expect(text).toContain('event: token');
    expect(text).toContain('event: error');
    expect(text).not.toContain('event: done');
  });
});

describe('POST /api/chat with a fallback configured', () => {
  test('a Workers AI rate limit is answered by the external provider', async () => {
    mockExternal(() => completion('fallback answer'));
    const { env, sqlite, ai, vectorize } = createEnv({
      FALLBACK_BASE_URL: BASE,
      FALLBACK_MODEL: 'm',
      FALLBACK_API_KEY: KEY,
      RERANK: 'false',
    });
    sqlite.run(`INSERT INTO sites (id, domain, sitemap_url) VALUES ('docs', 'docs.example.com', 'https://docs.example.com/s.xml')`);
    (vectorize.index as unknown as { query: () => Promise<unknown> }).query = async () => ({
      matches: [{ id: 'p-0', score: 0.9, metadata: { siteId: 'docs', pageId: 'p', url: 'https://docs.example.com/a', title: 'A', chunk: 0, text: 'alpha' } }],
      count: 1,
    });
    ai.state.handler = (_model, inputs) => {
      if (Array.isArray(inputs.text)) return { data: inputs.text.map(() => new Array(1024).fill(0.01)) };
      return rateLimited();
    };

    const res = await worker.fetch(
      new Request('https://w.example.com/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ siteId: 'docs', question: 'q?' }),
      }),
      env,
      createCtx().ctx,
    );
    expect(res.status).toBe(200);
    expect(((await res.json()) as { answer: string }).answer).toBe('fallback answer');

    const health = (await (await worker.fetch(new Request('https://w.example.com/api/health'), env, createCtx().ctx)).json()) as Record<string, unknown>;
    // The public health check exposes nothing about the fallback provider (and does no D1 read).
    expect(health.fallback).toBeUndefined();
    expect(health.ok).toBe(true);
    expect(JSON.stringify(health)).not.toContain(KEY);
    expect(JSON.stringify(health)).not.toContain(BASE);
  });
});
